# Validation evidence

These results were observed on 2026-10-07. They supplement the automated tests;
they do not replace verification of a new plan or its current-head CI. GitHub App
mode is deferred; this evidence uses the supported PAT mode.

## Gradle wrapper generation (E2)

bump-it opened the owner-approved wrapper fixture's PR #1, moving the official
root wrapper from **9.7.1 to 9.8.0**. The tool generated it twice under the sandbox
with `--no-daemon`, verified the distribution URL/checksum and official wrapper JAR
checksum, and recorded all four wrapper files' bytes and executable modes.
`gradlew` was unchanged; the other three files changed. The PR's `check` passed on
head `83f2850d3a3a91f3220efc10d29aa4d7410d2955`.

The run completed successfully with **zero skill calls and zero model tokens**.
This proves real wrapper generation and publication without a model, beyond the
earlier public-catalog selection checks and network-free unit tests. No fixture
source or private configuration is reproduced here. The PR was still unmerged
when this evidence was recorded.

## Joint unlocked floor removal (D2)

Real sandboxed probes and final secure-it verification ran on synthetic projects
using public packages. The Gradle probe used `--no-daemon` and disabled dependency
locking; npm resolved without its lockfile under the configured seven-day window.

| Fixture | Parent and unlocked resolution | Security floor | Compatibility floor | Result |
|---|---|---|---|---|
| Gradle | `org.apache.commons:commons-compress:1.27.1` resolves `commons-io:commons-io:2.16.1` in `:probeClasspath` | Commons IO 2.16.1 for CVE-2024-47554 / GHSA-78wr-2p64-hpwj | `commons-codec:commons-codec:1.17.1` | Security floor **REMOVED**, compatibility floor **KEPT** |
| npm | `express@4.21.2` requires `path-to-regexp@0.1.12` | path-to-regexp 0.1.12 for CVE-2024-52798 / GHSA-rhx6-c78j-4q9w | `ms@2.1.3` override | Security floor **REMOVED**, compatibility floor **KEPT** |

Both joint proofs passed. The computed removal was applied to separate copies;
final verification passed with no problems. No PR or package was published by
these probes.

The real java-conventions Guava probe also exercised the refusal path: the
security floor was **retained** because its parents still resolved vulnerable
Guava without it. A successful removal on a fixture is not permission to remove
that repository's still-needed floor.

## Automated checks and skips

`npm run check` runs all workspace typechecks and tests. CI enables the seven real
Gradle inventory acceptance tests with `SUPPLY_CHAIN_GRADLE_TESTS=1`; local checks
skip them unless explicitly enabled. The Seatbelt test skips when `codex sandbox`
cannot apply a sandbox inside the current process. macOS launchd plist checks skip
on other operating systems. Report these skips separately from passed tests.

The reusable workflow also inventories base/head and runs the gate on the exact
PR candidate. Its rescan-only jobs normally skip on a pull-request event; their
scheduled/dispatch execution is a separate check, not a failed acceptance test.
