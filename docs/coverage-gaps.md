# Coverage gaps

What the gate can't see, and how it says so. Gaps are listed in every report; none of them reads as clean.

- **Operating-system packages** in container images: no scanner here reads them (Trivy or similar, later).
- **Dependencies without a GitHub source repository** (npm `repository` and POM `scm` name none): OSV still covers them; their own repository advisories can't be read.
- **Repository advisory ranges the gate can't read**: free-text ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0–33.7.1`, `≤ 3.4.1`, `4.1.91.Final =< 4.1.117.Final`), but prose such as `< 2.245.0 (on Windows, < 2.246.0)` is reported, not guessed. One reading is known to over-match: an AND range written upper bound first (`< 2.0.0, >= 1.0.0`) reads as every version.
- **Unpinned or unverified actions** a PR didn't touch (`uses: actions/checkout@v7`), and `docker://` actions: their version (and advisories) can't be told. A new or changed one must be pinned.
- **Local actions without an `action.yml`**, and local reusable workflows that don't exist.
- **What a Gradle build hides from its own inventory** (see the [security model](security-model.md)).
- **Packages from another npm registry**: the gate checks age and identity against the npm registry only, so they fail, or (own packages) need a reviewed `identity` exception.
- **Maven versions outside Maven Central and the Gradle Plugin Portal**: their release age can't be checked, so they fail unless configured.
- **Scheduled runs are best effort**: GitHub may delay or skip them, and disables them after 60 days without activity in a public repository.
