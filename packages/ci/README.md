# supply-chain CLI

The CI gate. It reads what a repository installs (npm lockfiles, what Gradle builds really resolve, and the actions its workflows use), looks every package version up against **one advisory snapshot**, and:

- on a **pull request** (`compare`), fails only on what the PR makes worse: a finding head has and base doesn't, malware anywhere in head, or an added or changed version that fails the release-age, source or identity checks;
- on the **default branch** (`scan`), fails on every finding without a valid exception, so a dependency flagged after it merged turns `main` red.

It runs with Node 24 (type stripping), with `yaml` (which keeps the comments where actions name their versions) and `semver` (npm peer compatibility and supported Node runtime ranges), and reads files from git objects or the working tree. The only thing that runs code from the checked repository is `gradle-inventory`, which runs its Gradle build to learn what it resolves; in CI that happens in a job of its own, and the comparison only reads the JSON it wrote.

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

`gradle-inventory` runs [`gradle/supply-chain-inventory.init.gradle`](gradle/supply-chain-inventory.init.gradle) on a clean checkout (or, with `--head worktree`, on the working tree as it is, for the tools' own edits) and records, for every project, **every resolvable configuration**: runtime, compile and test classpaths, annotation processors, tool configurations (checkstyle, pitest, jacoco…), the buildscript classpath (where `plugins {}` and `buildscript {}` put plugins) and the settings classpath. Each configuration lists what resolution selected, what it couldn't resolve, and the external dependencies it declares or inherits, with Gradle's `because(...)` reason. With `--init-script <file> --define <key>=<value>`, another init script runs first, given that system property: the tools pass [`gradle/supply-chain-reference.init.gradle`](gradle/supply-chain-reference.init.gradle) and a plan, to inventory the base with the plan applied by Gradle (the reference their edits must match), or secure-it's floor-removal script.

- `buildSrc`, included builds and plugin builds (`pluginManagement { includeBuild(...) }`) that Gradle configures from the root build are covered by the same run, under their own location prefix (`buildSrc/:compileClasspath`). Each build also writes a manifest from Gradle's own model (its projects and nested builds), so a project without output, or a nested build the run didn't export, fails the run; such a build has to be listed in `gradle.builds`.
- A configuration that doesn't resolve fails the run on either side: a hole in the inventory would read as clean. `gradle.ignoreConfigurations` names locations to leave out, explicitly.
- The inventory names the commit it was made from, and `compare`/`scan` check it matches and covers the builds the tree lists.
- Base and head each have their own sources: a PR can add a repository's first Gradle build (base needs no inventory) or remove its last one (base's inventory still counts, and what it had shows as fixed).
- A plugin's injected dependencies show up in its consumers' builds, which run this gate themselves (for example, java-conventions' checkstyle and errorprone dependencies in sqs-codec).
- Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory; keeping that job apart keeps it from touching the comparison and its credentials, not from lying about itself.

## GitHub Actions

Every `uses:` in `.github/workflows/*.yml`, in `.github/actions/**/action.yml`, in a root `action.yml`, and in every local `./` action a workflow uses (a local reusable workflow, `./.github/workflows/x.yml`, is read as the workflow it is), is an action version, located in the file that uses it. Files are parsed as YAML (comments kept, aliases followed, a file that doesn't parse fails), and every `uses:` key counts.

- A use resolves to a version when it's pinned to a full commit SHA and its comment names a full release tag (`# v7.0.1`, `# tag=v7.0.1`; a floating `# v7` doesn't say what's pinned) that GitHub says points at that commit, annotated tags dereferenced.
- **A new or changed `uses:`** must resolve: a tag or branch ref, a missing comment, or a comment whose tag points elsewhere fails. Each occurrence is judged on its own: same file, action (subdirectory included), ref and comment as in base, and no more copies of it than base had, or it's a change (so dropping a comment, using another action of the same repository, or copying an unpinned ref into another workflow or step, a YAML alias included, counts). Its age is its GitHub release's publish time (a tag's own date is whatever its author wrote); no published release fails, own actions aside (`ownPackages["GitHub Actions"].owners`).
- An unchanged `uses:` that doesn't resolve, `docker://` uses, a local action without an `action.yml`, and a local reusable workflow that doesn't exist are coverage gaps: the PR didn't make them worse.
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

- **Release age:** published at least `releaseAgeDays` (default 7) ago, unless it's an own package, or it's the security fix the version rule picks (below), or its independently proved required npm dependency (below), or a `releaseAge` exception names an advisory that, in this run's snapshot, affects a version the PR replaces and not this one (malware advisories don't count).
- **Source:** every locked package comes from an allowed registry (`npm.registries`, default the npm registry) as its own tarball: on the npm registry exactly `<name>/-/<unscoped name>-<version>.tgz`; elsewhere the full name (scope included) as consecutive path segments followed by that same `-/<unscoped name>-<version>.tgz` or by the exact version (GitHub Packages' `download/@scope/name/<version>/…`), so a lockfile can't keep a name and version while fetching another package's archive. The gate checks age and identity only against the npm registry, so a package from another allowed registry fails, unless it's an own package with an unexpired `identity` exception recording that its publish was reviewed (own packages skip only the wait).
- **Identity:** a version that replaces another fails on a publisher identity break: provenance dropped or from another repository or workflow, provenance from a repository the replaced version doesn't declare, or (without provenance) a publisher who hadn't published the package up to the replaced version. Every provenance statement must name the exact package, version and locked sha512.
- Bundles the lockfile doesn't fully record fail: every `bundleDependencies` entry, and what it depends on, needs an `inBundle` entry inside the package that ships it.

The CLI's `npm-signatures` command runs scriptless `npm ci` and `npm audit signatures` in fresh temporary projects containing only the selected lockfile and root/workspace manifests. It ignores repository `.npmrc` files and ambient npm/proxy settings, uses only gate-approved registries, and disables Git execution. Git, tarball URL and external file dependencies are refused; internal workspace links remain supported. The PR job and daily rescan use this same verifier; the rescan skips it unless comparison passes. See the [security model](../../docs/security-model.md) for the publisher's execution boundary.

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

## npm dependencies required by a security fix

A rule-picked npm security fix can require a dependency whose satisfying versions are all younger than the window.
Only the lowest stable, non-deprecated version satisfying the registry requirement and existing applicable constraints
gets an age exemption. If any satisfying version is aged, the ordinary age rule applies. The exception is a requirement
that reaches another security fix verified in the same comparison: when that fix's version satisfies every applicable
range, it is the one chosen (exempt if young), rather than a lower version the fix moved away from. Unknown dates or manifests
cannot prove the absence of an aged alternative and block the proof. An unsafe lowest target is not replaced by a
higher young choice: source, publisher identity, advisories and malware checks still apply.

The gate independently identifies all rule-picked security roots from replaced versions and the shared advisory
snapshot before reconstructing their joint closure. Ordinary head upgrades stay at their base versions in the proof;
they cannot manufacture a stricter requirement. The gate then reads dependency and peer requirements from registry manifests, including aliases, new packages and recursive requirements through
aged dependencies. Direct peer companions stay in their existing compatible line. It resolves actual lockfile
locations and checks exact landing. Direct peer companions are solved jointly, including reciprocal requirements;
an outgoing peer requirement constrains only the copy its root actually resolves. Complete assignments are ordered
by package name (then location), preferring aged versions and then lowest versions; an eligible aged locked version
is preserved. Each young choice is checked against the rest of its selected assignment for aged alternatives and
the lowest satisfying version. Installed optional dependencies
replace same-key ordinary requirements; optional dependencies absent from the lock are not introduced. Baseline overrides
constrain the proof; PR annotations, narrowed root declarations and new overrides cannot grant exemptions.
The proof is limited per root to depth 8, 128 visited package/location/version nodes and 2,048 satisfying versions per
requirement; a limit hit is an explicit blocker, never a partial exemption. Cycles stop at already visited nodes.
Peer components are limited to 128 companions, 2,048 candidate versions each and 4,096 attempted assignments per
search; exhaustion blocks the proof. Required targets must land in head and use the comparison's one advisory
snapshot. Ordinary bumps do not qualify, and this extension
applies only to npm; Maven/Gradle and Actions keep their existing age rules.

## The cooldown: young versions are held, however justified

Passing the release-age rule makes a young version *acceptable*, not *trusted*. Whoever controls a publisher (a
stolen token, a hijacked release workflow) can put malware inside a real fix, and an advisory's severity says how bad
the hole is, not how trustworthy its fix is: urgency is exactly what such an attack would lean on. So every version
a PR adds or changes that is younger than `releaseAgeDays` is **held**, whether the rule picked it, a security fix
requires it, or a `releaseAge` exception names it:

- The `supply-chain` verdict is unchanged: it says whether the change is right.
- The separate `cooldown` job stays red while anything is held (and whenever it can't tell: a comparison that didn't
  pass, a missing report, a report for another head). Its log and step summary list each held version and when it
  turns old enough. Require it next to `supply-chain` (see GitHub settings below).
- The policy that judges a PR is the stricter of base's and head's: the longer `releaseAgeDays`, and own packages
  only where both list them. A PR can't loosen the cooldown that judges it; change the policy in a PR of its own
  first. A base whose settings don't parse leaves the cooldown unevaluated (red).
- Exceptions don't clear a hold. Taking a held version before its time is a person's decision: every other check
  green, the reason written on the PR, then an admin merge past the red `cooldown` check. Where nothing enforces
  the check (no ruleset, e.g. a private repository on the free plan), the same: a merge with the reason written.
- The daily rescan re-judges the cooldown under the base's current policy and posts it as a status named like the
  required cooldown check: a PR that was green under a shorter wait is held again when the base raises it. A status
  can't clear a red `cooldown` job, though: secure-it retires its held PRs once everything aged and opens a fresh one;
  for a person's PR, re-run the **whole** workflow on the current revision after the time it gives (a re-run of the
  `cooldown` job alone reads the old report and stays red).

`compare` writes the held versions into its report (`cooldown`, report schema 2); `supply-chain cooldown --report
<file> --head <sha>` reads it, refusing anything but a complete, passing comparison of that exact head.

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

`--report <file>` writes JSON: `schemaVersion`, `mode`, the gate's commit and OSV-Scanner version, a digest of the config, `baseSha`, `headSha` (the daily rescan's reports also carry `prHeadSha`, the PR's own head, since its `headSha` is that head merged onto the base's tip), `startedAt` (the snapshot's time), `completedAt`, `completed`, `verdict`, and the failures, warnings, notes and gaps.

## Adopting the gate

The reusable gate runs every GitHub-hosted job on `ubuntu-26.04`. Pin a commit that includes this runner setting.


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
    uses: leanish/supply-chain/.github/workflows/supply-chain.yml@cb630386ce9976cef5ba37665f4abc615f34d7fe # v0.1.0-rc.4-ubuntu26
    permissions:
      contents: read
      pull-requests: read # the daily rescan lists open PRs
      statuses: write # the daily rescan posts its verdicts
    with:
      java-version: "25" # for Gradle builds; several lines for several JDKs, the last one runs Gradle
```

What runs where:

- **On a PR:** two inventory jobs (base and head) run the Gradle builds with a read-only token; the `supply-chain` job compares their output and the lockfiles and workflows read from git, and its result is the verdict. It runs with `if: always()` and fails when an inventory job didn't succeed, so a skipped job never satisfies the required check. The `cooldown` job then reads the verdict's report: red while it holds young versions, and red when the comparison didn't pass (also `if: always()`, so it's never skipped on a PR).
- **On pushes to the default branch and daily:** the full `scan`.
- **Daily (and on `workflow_dispatch`):** every open PR's head is merged onto its base's current tip (the same commit in every job; the head itself, against its merge base, when the merge conflicts). One job per PR inventories the base, uploads it before any PR code runs, then inventories the merged PR. A single `rescan` job, the only one with write access and running no code from the repository, then goes through the PRs: re-reads each (still open, same head, same base), compares it with today's advisories, checks npm signatures in clean temporary projects only when comparison passes, and posts the verdict as a commit status on the PR's head, named like the required check, and, once the comparison completed, the cooldown under the base's current policy, named like the required cooldown check (an `error` for a PR that conflicts with its base, whose merge base's policy isn't current); neither is posted over a newer status of its name. A PR whose inventories or comparison didn't complete gets a failure. Verdicts never leave that job, so nothing another job uploads can stand in for one; the tools it runs (npm, git) never get its token in their environment.

**GitHub settings**

- A ruleset (or branch protection) on the default branch requiring the checks `supply-chain / supply-chain` and `supply-chain / cooldown` (`<your job id> / …`; pass `required-check` and `required-cooldown-check` if you call the job something else, or require a bridge job's checks instead), from GitHub Actions. secure-it and bump-it recognise the cooldown hold by those job names and the job's steps, and the daily rescan's hold by a `failure` status of the cooldown check's name (a cooldown it can't evaluate is an `error`); they recognise only `cooldown` or a name ending in ` / cooldown`, so a differently named cooldown check makes a held PR look broken to them (adapted, then closed). GitHub then requires both the check and the daily status of that name to pass: a red status blocks a PR whose own check was green, and the latest status wins. Required checks on private repositories need a paid plan.
- Actions enabled, allowing the actions this workflow uses (actions/checkout, setup-node, setup-java, upload-artifact, download-artifact).
- The dependency graph and Dependabot **alerts** on; Dependabot version and security updates off (secure-it and bump-it make those PRs, with this gate's rules).

**Limits**

- **Fork PRs:** their workflow runs from the fork's own files, with a read-only token and no secrets, so their check is only as trustworthy as the PR: review workflow and build changes, require approval for outside contributors' runs, and don't merge before the daily rescan's status lands (or trigger it with `workflow_dispatch`, `pr` input).
- **Scheduled runs** are best effort: GitHub may delay or skip them under load, and disables them in a public repository after 60 days without activity.
- **The rescan goes through PRs one after another** in one job (up to 256 open PRs): minutes per PR, fine for a repository's own pace of work, slow for hundreds of open PRs.
- A PR's build runs in its inventory job, which could also upload an artifact under another PR's name; such cross-PR tampering can make that PR's inventory lie, like a build can lie about its own.
- The Gradle inventory comes from running the build, so a malicious build script or plugin can alter its own inventory; the job split keeps it from touching the comparison and the publishing credentials, not from lying about itself.

**Updating the pin:** a PR that changes the SHA (and its `# vX.Y.Z` comment); bump-it does it like any other action update.

## Picking a fix: `candidates`

`supply-chain candidates --rule security|bump [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--out <file>]` prints, as JSON, where secure-it and bump-it move versions.

**`--rule security`** picks, for every version a full scan fails on, the version the rule above picks: what secure-it moves to. It reuses the rule's code, so what it picks is what the gate then accepts.

- **Candidates:** every version above it the registry lists, in any line, scanned in a second snapshot together with the version itself.
- **Targets:** the version's failing advisory groups (an excepted one stays as it is), as that second snapshot groups them (a candidate can link aliases). A target no listed version fixes is reported as `unfixable` and left: fixing A and leaving B is allowed.
- **The choice:** the rule's first line, lowest aged fix, else lowest fix; a choice outside the version's own line is flagged `major`, for the agent to adapt the code. Own packages skip the wait.
- **Malware:** the nearest clean version at least `releaseAgeDays` old (own packages: any age): newer in its line first, then older in its line (a downgrade), then a newer line.
- **Blockers:** an npm choice whose publisher identity `compare` would reject keeps the rule's version and lists the break: it needs a reviewed `identity` exception.
- **No choice:** each entry says why (no version fixes, an older fix's publish time is unknown, the registry can't list the versions).
- **Incomplete inventories:** a Gradle configuration that didn't resolve or an unrecorded bundle is listed under `incomplete`, and the command exits 2: an empty list then doesn't mean nothing fails. Coverage gaps (actions included) are listed too.

On sqs-codec today it picks Guava 33.7.2-jre for 33.5.0-jre and 33.7.1-jre, and snappy-java 1.1.10.10 (young, the lowest that fixes all seven advisories) for 1.1.10.8.

**`--rule bump`** gives, for every directly declared dependency, the highest version at least `releaseAgeDays` old (own packages: any age) that adds no advisory group, no malware and, on npm, no publisher identity break: in its own line (`minor`: minors and patches, one PR together) and in the highest newer line that has one (`major`: a PR of its own; lines are tried from the highest down). Direct means the npm dependencies the root and the workspaces of every checked lockfile declare (each with the copy Node resolves for it, walking up from the workspace; `npm:` aliases under their target's name, with the key and range to edit in `declarations`), the Gradle dependencies declared with a version (recorded floors aside: bump-it doesn't raise floors) where the repository's Gradle sources name them, and every `uses:` pinned to a release; Gradle transitives are never bumped. Gradle's declarations include what plugins add (the Kotlin DSL plugin's embedded Kotlin, for one), which no build file can move, so a Gradle dependency counts only when the repository's Gradle sources name its coordinate. That evidence is deliberately coarse, read as raw text from every `*.gradle`, `*.gradle.kts` and `*.toml` file and the code under `buildSrc/` and `build-logic/`, anywhere in the repository: a quoted string starting with `group:name` (`"g:n"`, `"g:n:${v ?: d}"`), `group` and `name` both quoted whole in one file, a version catalog entry (TOML files are also parsed), or, for a plugin (its marker `id:id.gradle.plugin`), its id quoted whole or before a `:`. Comments count, and a name anywhere counts for every build. The rest are listed in `notes`, as not moved automatically. Known limitations, each of which only costs an automatic update (skipped and listed in `notes`, or an attempt that fails visibly, as before this evidence existed): shorthands such as `kotlin("stdlib")` and escapes inside Kotlin/Groovy strings aren't read; files outside the repository aren't read; a coordinate named only in a comment, or in another build, is still attempted; the tools verify a Gradle edit against a reference, the base with the plan applied by Gradle itself (so what a planned plugin update adds, moves or removes is expected wherever the plugin comes from), and that fails visibly when a planned declaration also reaches a configuration the plan doesn't list, when the base declares several versions of a planned package where it's planned, when a shared catalog version also moves an unplanned package, or when the base doesn't configure with the new version (a plugin major that dropped DSL the build uses); a vulnerable dependency a plugin declares with `strictly(...)` can't be floored (the floor fails resolution), nor one a plugin adds through `defaultDependencies` next to others (an explicit floor replaces the plugin's defaults, which verification sees removed); a floor that replaced a plugin's default can't be removed automatically later (the default reappears); and a routine update that needs an edit outside the build scripts and the `gradle/libs.versions.toml` catalogs (another TOML file, convention code) fails verification's file check, since only a major may change other files. It weighs a line's ten newest versions old enough, and says so when all of them are out.
