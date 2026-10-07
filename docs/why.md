# Why this, and not just Dependabot, OSV-Scanner or Renovate

Those tools are good, and this repository uses two of them: [OSV-Scanner](https://github.com/google/osv-scanner) finds the advisories, and Dependabot's **alerts** stay on as a second source. What they don't do, alone or together, is the reason this exists.

## What the gate adds

- **A PR fails only on what it makes worse.** Base and head are read against **one** advisory snapshot (one OSV-Scanner run over both, one pass over every repository advisory), and a finding is ecosystem + package + advisory group, whatever the version or location. So an upgrade that fixes A while B still affects the new version passes, an advisory published this morning on a dependency both sides share is a warning, not a blocked PR, and only a finding the PR brings fails. Malware fails always.
  - OSV-Scanner's own PR mode compares advisory ids without the package, so a PR that swaps one vulnerable package for another with the same advisory id passes, and inherited malware isn't "new".
  - Dependabot's dependency review checks what a PR adds, against GitHub's database only, and fails on any advisory of an added version, even one the base already had.
- **Advisories before the databases have them.** The gate reads the security advisories each dependency's own GitHub repository publishes. Those can be days ahead of GitHub's reviewed database and of OSV: snappy-java's CVE-2026-90559 and six more, and three vite advisories published the same day, were in neither OSV nor GitHub's database when this gate first reported them.
- **Every external module Gradle really resolves.** Not a manifest's declared dependencies: the module coordinates of every resolvable configuration of every project (tests, annotation processors, Checkstyle, PIT…), the buildscript and settings classpaths, buildSrc and included builds, as Gradle resolved them. Local files and JARs aren't modules and aren't covered.
- **The age rule, with a proof instead of a bypass.** Every new version waits 7 days, but a young version passes when it's exactly the security fix the version rule would pick: the lowest fixing version in the compatible line, with no older fix in that line. A backport beats a newer major; a hand-written exception is the last resort, not the routine.
- **Publisher identity.** When an npm version replaces one the registry still lists, it fails if its publisher never published the package before (without provenance on either side) or if its provenance moved to another repository or workflow; valid provenance from the same source accepts a new publisher. A package new to the repository has no earlier version to compare with, so this check doesn't apply to it.
- **Recorded floors, checked.** A floor recorded in `.github/dependency-floors.json` must be declared at that version with a `because(...)` naming its advisories, and resolve at or above it (npm: the override must pin it and the lockfile install it); every npm override needs an entry. A Gradle declaration with a reason but no entry is a note, not a failure. Removing floors that are no longer needed is secure-it's job (planned).
- **Remote actions are dependencies too.** A new or changed remote action or reusable workflow must be pinned to a commit whose comment names a tag pointing at it; GitHub's database and the action's own repository advisories are checked like any package's. Local actions are followed to their `action.yml`; `docker://` actions are a reported gap.
- **Open PRs are rescanned daily**, merged onto their base's current tip, and the verdict lands as a status GitHub requires next to the PR's own check.

## What secure-it and bump-it add

- **Transitive fixes at any depth.** A vulnerable package four levels down gets the smallest change that fixes it: a lockfile update, an override, or a Gradle floor recorded with its `because(...)`. Dependabot's security updates only see GitHub-reviewed advisories, don't write Gradle floors, and can be blocked by another open PR touching the same lockfile.
- **One rule per job.** secure-it takes the smallest fix (lowest version, compatible line first); bump-it takes the highest version at least 7 days old that adds no finding, minors and patches together, each major apart, with a model that can adapt code to a major.
- **Floors come off when they're no longer needed** (being built): secure-it will resolve without them, together and without the lockfile's influence, and remove the ones that turned redundant.

## What each alternative does better

- **Dependabot** alerts and security updates are a switch in the repository settings, cover ecosystems this gate doesn't, and the alerts are free; keep them on. Version updates need a `dependabot.yml`, and then cost nothing to run.
- **OSV-Scanner** alone is enough for a full scan of one tree, and has call analysis for Go and Rust.
- **Renovate** has far more managers, grouping and scheduling options, and auto-merge, and runs as a hosted app.
- **None of them** compares base and head against the same data, reads repository advisories, or proves a young fix; that's the niche.

## Why not run Dependabot updates or Renovate next to bump-it

This project's choice: one producer of update PRs per repository. Renovate can refresh npm lockfiles and Dockerfile versions, and Dependabot can update indirect dependencies, so they could take some routine updates; what neither does is pick versions by bump-it's planned rule (the highest version old enough that adds no finding, judged on the same advisory snapshot the gate uses) or adapt code to a major with an agent. Running one of them next to bump-it would add a second producer of PRs on the same lockfiles, with its own configuration and conflicts. Dependabot's alerts stay on: free, a second source, and nothing to maintain.
