# Changelog

## Unreleased

### Fixed

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
