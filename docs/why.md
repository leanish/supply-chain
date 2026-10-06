# Why this, and not just Dependabot, OSV-Scanner or Renovate

Those tools are good, and this repository uses two of them: [OSV-Scanner](https://github.com/google/osv-scanner) finds the advisories, and Dependabot's **alerts** stay on as a second source. What they don't do, alone or together, is the reason this exists.

## What the gate adds

- **A PR fails only on what it makes worse.** Base and head are read against **one** advisory snapshot (one OSV-Scanner run over both, one pass over every repository advisory), and a finding is ecosystem + package + advisory group, whatever the version or location. So an upgrade that fixes A while B still affects the new version passes, an advisory published this morning on a dependency both sides share is a warning, not a blocked PR, and only a finding the PR brings fails. Malware fails always.
  - OSV-Scanner's own PR mode compares advisory ids without the package, so a PR that swaps one vulnerable package for another with the same advisory id passes, and inherited malware isn't "new".
  - Dependabot's dependency review checks what a PR adds, against GitHub's database only, and fails on any advisory of an added version, even one the base already had.
- **Advisories before the databases have them.** The gate reads the security advisories each dependency's own GitHub repository publishes. Those can be days ahead of GitHub's reviewed database and of OSV: snappy-java's CVE-2026-90559 and six more, and three vite advisories published the same day, were in neither OSV nor GitHub's database when this gate first reported them.
- **Every dependency Gradle really resolves.** Not a manifest's declared dependencies: every resolvable configuration of every project (tests, annotation processors, Checkstyle, PIT…), the buildscript and settings classpaths, buildSrc and included builds, as Gradle resolved them.
- **The age rule, with a proof instead of a bypass.** Every new version waits 7 days, but a young version passes when it's exactly the security fix the version rule would pick: the lowest fixing version in the compatible line, with no older fix in that line. A backport beats a newer major; a hand-written exception is the last resort, not the routine.
- **Publisher identity.** A new npm version from a publisher who never published the package, or provenance that moved to another repository or workflow, fails.
- **Floors that can't rot.** Every forced minimum version is recorded with its reason, and checked against what Gradle declares and resolves (or what npm overrides pin and the lockfile installs).
- **Actions are dependencies too.** A new `uses:` must be pinned to a commit whose comment names a tag pointing at it; GitHub's database and the action's own repository advisories are checked like any package's.
- **Open PRs are rescanned daily**, merged onto their base's current tip, and the verdict lands as a status GitHub requires next to the PR's own check.

## What secure-it and bump-it add (being built)

- **Transitive fixes at any depth.** A vulnerable package four levels down gets the smallest change that fixes it: a lockfile update, an override, or a Gradle floor recorded with its `because(...)`. Dependabot's security updates only see GitHub-reviewed advisories, don't write Gradle floors, and can be blocked by another open PR touching the same lockfile.
- **One rule per job.** secure-it takes the smallest fix (lowest version, compatible line first); bump-it takes the highest version at least 7 days old that adds no finding, minors and patches together, each major apart, with a model that can adapt code to a major.
- **Floors come off when they're no longer needed**: secure-it resolves without them (and without the lockfile's influence) and removes the ones that turned redundant.

## What each alternative does better

- **Dependabot** needs no setup at all, covers ecosystems this gate doesn't, and its alerts are free; keep them on. Its version updates cost nothing to run.
- **OSV-Scanner** alone is enough for a full scan of one tree, and has call analysis for Go and Rust.
- **Renovate** has far more managers, grouping and scheduling options, and auto-merge, and runs as a hosted app.
- **None of them** compares base and head against the same data, reads repository advisories, or proves a young fix; that's the niche.

## Why not run Dependabot updates or Renovate next to bump-it

They wouldn't take work away from bump-it, which would still do transitive npm updates, Dockerfile and lockfile-backed CLI versions, code adaptation for majors and the full version rule; they would add a second producer of PRs on the same lockfiles, with its own configuration and conflicts. Dependabot's alerts stay on: free, a second source, and nothing to maintain.
