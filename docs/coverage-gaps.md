# Coverage gaps

What the gate can't see. Two kinds: **reported gaps**, which every report lists next to its verdict (a verdict can pass with them), and **limits**, which no report mentions because the gate can't detect them.

## Reported gaps

- **Dependencies without a GitHub source repository** (npm `repository` and POM `scm` name none): OSV still covers them; their own repository advisories can't be read.
- **A known source repository whose advisories can't be read**: renamed, deleted or made private (404).
- **Repository advisory ranges the gate can't read**: free-text ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0–33.7.1`, `≤ 3.4.1`, `4.1.91.Final =< 4.1.117.Final`), but prose such as `< 2.245.0 (on Windows, < 2.246.0)` is reported, not guessed. One reading is known to over-match: an AND range written upper bound first (`< 2.0.0, >= 1.0.0`) reads as every version.
- **Unpinned or unverified remote actions** a PR didn't touch (`uses: actions/checkout@v7`): their version (and advisories) can't be told. A new or changed remote action or reusable workflow must be pinned; that fails, it isn't a gap.
- **`docker://` actions**, new or not: no advisory source covers container images.
- **Local actions without an `action.yml`**, and local reusable workflows that don't exist.

## Limits

- **Operating-system packages** in container images: no scanner here reads them (Trivy or similar, later).
- **Code copied into a package without its own manifest**: npm bundles are read package by package (each bundled `node_modules/<name>/package.json`); JavaScript vendored into a package's own files, like classes shaded into another Java artifact, isn't a package anywhere, so its advisories can't match.
- **What a Gradle build hides from its own inventory** (see the [security model](security-model.md)), and dependencies that aren't external modules: the inventory exports module coordinates only, so local files and JARs aren't covered.
- **Scheduled runs are best effort**: GitHub may delay or skip them, and disables them after 60 days without activity in a public repository.

## Checks that fail rather than leave a gap

These apply to versions a PR adds or changes, in `compare`; unchanged versions and the full `scan` don't get them.

- **Packages from another npm registry**: age and identity are checked against the npm registry only, so they fail, or (own packages) need a reviewed `identity` exception.
- **Maven versions outside Maven Central and the Gradle Plugin Portal**: their release age can't be checked, so they fail unless configured. Own Maven packages skip the age check.

## Gradle wrapper updates

bump-it selects and verifies the root Gradle wrapper separately from the gate's dependency inventory. It reads
stable, non-broken releases from services.gradle.org and published repository advisories from gradle/gradle; this
is not a scan of the distribution archive. Nested wrappers, mirrors, custom distributions and prerelease base
wrappers are not upgraded. The official wrapper jar is checksummed; generated shell/batch scripts are not
independently compared with official scripts, but all four generated files are protected byte for byte and by executable
mode against agent edits. A missing or unreadable advisory range leaves the wrapper out with a reported reason;
other moves continue. Verification of a planned wrapper fails closed.
