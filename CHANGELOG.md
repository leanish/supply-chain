# Changelog

## Unreleased

### Fixed

- bump-it no longer plans Gradle dependencies a plugin adds (the Kotlin DSL
  plugin's embedded Kotlin, for one): it moves a Gradle dependency only where
  its build's own scripts, version catalogs or `buildSrc`/`build-logic` code
  name it (plugins through `id(...)` or a catalog plugin), and lists the rest
  as not moved automatically. Gradle reports
  plugin-added dependencies as declared, so bump-it asked its agent, on every
  run, to move declarations that don't exist.

### Changed

- The `ci` package depends on `smol-toml` (1.9.0, zero dependencies) to read
  Gradle version catalogs, and on `fast-xml-parser` (5.11.2, with seven
  dependencies of its own, all from its author) to read POMs and Maven
  metadata, under size, nesting and entity budgets. Both run in the gate and
  the tools only.
- POMs and `maven-metadata.xml` are read as XML, not with patterns: only the
  project's own `<scm>`, `<url>`, `<properties>` and `<parent>` count (not a
  profile's or a plugin's), CDATA and entities are decoded, and a commented-out
  `<version>` no longer counts as a published version.

## 0.2.1 - 2026-10-09

### Fixed

- A security fix whose required dependency is another security fix in the same
  batch keeps that fix's own version when it satisfies the requirement: the
  requirement proof chooses it instead of re-picking a lower (possibly still
  vulnerable) young version and rejecting the right one. A fix that needs the
  other fix's young version, directly or through it, stays with it in
  secure-it's retries and cooldown split.
- secure-it updates an object-form security override (`{ ".": "1.0.0", "child": … }`)
  by its own `.` version, keeping its child rules and their floor records.

## 0.2.0 - 2026-10-09

### Changed

- **Young versions are held.** Passing the release-age rule (the rule-picked
  security fix, a version it requires, a `releaseAge` exception) no longer makes
  a young version mergeable on green: whoever controls a publisher can ship
  malware inside a real fix, whatever the advisory's severity. The reusable
  workflow's new `cooldown` job stays red while a PR adds or changes a version
  younger than the wait, and whenever it can't tell. Adopters should require
  `supply-chain / cooldown` next to `supply-chain / supply-chain`. Taking a held
  version earlier is a person's decision: the reason written on the PR, then an
  admin merge. Exceptions don't clear a hold.
- The release-age wait and own packages that judge a PR are the stricter of
  base's and head's settings, so a PR can't loosen them for itself.
- The gate's report is schema 2: comparisons record the held versions.
- secure-it puts young fixes (and fixes whose required npm dependency is young)
  in a draft PR of their own, topic `security-cooldown`, so the aged fixes go out
  as usual. A held PR opens with a warning listing what came early, why, and npm
  provenance, publisher and install-script signals. Review never marks it ready;
  once everything aged it closes the draft, and the next run opens a freshly
  verified PR. bump-it refuses any version the cooldown holds.

### Added

- `supply-chain cooldown --report <file> --head <sha>`, the `cooldown` job, and
  the workflow outputs `comparison-passed` and `cooldown-held`.
- secure-it proves and pins npm dependencies required by a rule-picked security
  fix. When no aged version satisfies a requirement, only its lowest stable,
  non-deprecated version gets the age exemption. The gate reconstructs the proof
  from registry metadata, jointly for independently verified security roots and
  reciprocal direct peers at their resolved locations, preserving complete
  assignments even when their versions are crossed. Optional dependencies
  replace same-key ordinary requirements. Missing data or proof/search bounds
  block it explicitly. Ordinary bumps, Maven and Actions receive no new age exemption.

### Fixed

- This repository's tests run on a held PR too: the `check` job no longer skips
  when only `gate / cooldown` failed.
- bump-it's CLI is committed executable, like the other `bin` targets. npm marks
  it executable on install, which showed up as a change in secure-it's own
  working copy of this repository and failed its verification.
- The gate, secure-it and bump-it retry transient GET/HEAD connection failures
  twice with bounded backoff and jitter, including interrupted response bodies.
  No overall timeout is added; caller cancellation and fetch timeouts still apply.
  Exhausted retries still fail closed; HTTP error responses and write requests
  are not retried.
- Concurrent metadata lookups stop scheduling after the first failure and wait
  for active requests to finish before reporting it. The POM limit stays at 16.
- Temporary exact npm declarations also align object-form self-overrides, keeping
  their child rules and restoring the repository's original overrides afterwards.
- secure-it refreshes computed npm files before verifying a clean same-plan rebase,
  preserving matching security-floor history and merged non-npm floor records.
- Both tools constrain npm targets with simultaneous temporary exact declarations
  before resolving, restore planned ranges and formatting, reinstall, and assert
  exact landing. Peer-resolved copies use root/workspace declarations instead of
  overrides npm can ignore; unsupported placements are reported without publication.
- secure-it writes and protects npm files mechanically before agent work, including
  peer companions and recorded security overrides; compare still judges induced transitives.
- `cannot-apply` skill answers may omit publication or return null. Applied answers
  still require complete, strictly validated publication text in both tools.
- secure-it and bump-it no longer fail to fetch or push a branch when their
  cached clone still tracks a deleted branch on a conflicting path (for example
  `bump-it` left behind while `bump-it/2026-10-08-routine` is fetched); the stale
  ref is dropped first.
- A failed git call's error quotes git's own stderr, bounded and with
  credentials masked, instead of only its exit code.

## 0.1.1 - 2026-10-08

### Fixed

- Built-in OpenAI model prices provide API-equivalent usage estimates, including
  cached input and per-request long-context rates; configured price overrides
  remain supported.
- Deprecated npm releases are excluded from direct and transitive target
  candidates, including accidental major releases.
- `@types/node` targets respect the lowest supported Node runtime across engines,
  version files, Volta and CI. The cap covers direct/peer targets, routine
  transitives and major-induced copies, with exact pinning and final checks.
- Scheduled-scan detection recognizes callers of the reusable supply-chain
  workflow, rather than requiring the caller's workflow name to match it.
- npm registry lookup URLs encode package/version path segments explicitly,
  addressing the CodeQL sanitization findings without changing package identity.

## 0.1.0 - 2026-10-08

### Added

- A CI gate for npm lockfiles, resolved Gradle modules and GitHub Actions, using
  one advisory snapshot for base/head. PRs fail on new findings and malware;
  default-branch daily scans and open-PR rescans keep verdicts current.
- Release-age, publisher/source identity, repository-advisory, exception and
  dependency-floor checks, including proof of eligible young security fixes.
- Standalone secure-it: non-major security batches, separate majors, peer-coupled
  direct fixes, and jointly verified unlocked removal of redundant security
  floors. Compatibility floors remain unchanged.
- Standalone bump-it: routine refreshes, separate capped/deferred majors,
  tool-computed exact npm files and checksummed Gradle wrapper generation.
  Peer-blocked major PRs are retained and reported during review.
- Shared sandboxed repository commands, isolated credentials, PR race checks,
  publication journal recovery, deterministic reconciliation and bounded CI
  adaptation. CI reads Actions and commit statuses without Checks permission.
- Per-tool PAT/Keychain defaults, strict configuration, current/legacy label
  recognition, candidate preview, launchd examples, logs and cost reporting.
- Provenance for copied agent basics, an adoption/configuration guide, security
  model, coverage gaps and a real-run validation record for wrapper generation
  and Gradle/npm floor removal.

### Scope

- Packages are private and consumed by pinned Git commit; no npm publication.
- Local tools currently run on macOS. GitHub App mode is future work; PAT mode
  remains supported. Unsupported ecosystems and other limits are documented in
  `docs/coverage-gaps.md`.
