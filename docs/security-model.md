# Security model

What can run where, and which credential it can reach.

## The CI gate

| Job | Runs code from the checked repository | Token | Writes |
|---|---|---|---|
| `plan` | no | `contents: read` | which mode and sides this run has |
| `inventory` (every run: base and head on PRs, head otherwise) | yes: Gradle runs the build to learn what it resolves | `contents: read` (fork PRs: read-only regardless) | the inventory file, as an artifact |
| `supply-chain` (the verdict) | no: lockfiles and workflows are read from git objects, the Gradle inventory as data | `contents: read` | its report |
| `rescan-plan` (schedule, dispatch) | no | `contents: read`, `pull-requests: read` | the list of PRs |
| `rescan-inventory` (one per open PR) | yes: the base's build, then the PR's | `contents: read`, passed only to the one `git fetch` that needs it | the two inventories (base first, uploaded before PR code runs) |
| `rescan` | no | `contents: read`, `pull-requests: read`, `statuses: write` | commit statuses on PR heads |

- **No checkout keeps credentials** (`persist-credentials: false`), so the build can't find a token in `.git/config`.
- **The tools that read the repository's own configuration get no token.** npm and the Gradle wrapper run with `GITHUB_TOKEN`, `GH_TOKEN` and the Actions runtime tokens removed from their environment: a PR's `.npmrc` can expand environment variables, and the build is the repository's code. git only reads the checkout (`show`, `ls-tree`), except the rescan's one fetch, which gets the token as a header for that command alone.
- **The verdict never leaves the job that computes it.** The PR job's result is its check; the daily `rescan` job posts statuses itself, so no artifact another job uploads can stand in for a verdict.
- **What a build can still do:** Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory (hide a dependency from it). The job split keeps it from touching the comparison and the publishing credentials, not from lying about itself; review build changes. A PR's build could also upload an artifact under another PR's name in the daily rescan (both are PR-controlled data).
- **Fork PRs** run the workflow from the fork's own files, with a read-only token and no secrets: their check is only as trustworthy as the PR. The daily rescan, which runs this repository's workflow from the default branch, gives them a trusted status; see the adoption guide in [`packages/ci/README.md`](../packages/ci/README.md).

## The gate itself

- It's pinned to one full commit SHA, and checked out from that same commit.
- OSV-Scanner is pinned by version and sha256 ([`packages/ci/tools.json`](../packages/ci/tools.json)).
- Its one runtime dependency (`yaml`) installs from this repository's lockfile, without lifecycle scripts.
- It fails closed on what it needs to judge: an unreachable registry, OSV or GitHub API, data that doesn't parse, or a build that didn't resolve fails the check, never "clean". What it can't read but doesn't need to judge (a source repository's advisories that return 404, a range it can't parse) is a coverage gap: listed in the report, next to a verdict that can pass.
- In the daily rescan, a PR whose inventories or comparison didn't complete gets a failure status. If the rescan can't plan at all (the GitHub API fails before it lists the PRs), it posts nothing: the PRs keep their last status, and the workflow run fails.

## secure-it and bump-it

secure-it is in this tree ([`packages/secure-it`](../packages/secure-it)); bump-it is being built on the same code ([`packages/remediation`](../packages/remediation)).

- **Two GitHub tokens per tool**, both personal access tokens for now (a GitHub App mode is planned):
  - one that writes (branches, PRs, comments), only for the tool's own process;
  - one read-only, which the coding agent gets as `GH_TOKEN`.

  The tool refuses two Keychain items holding the same token.
- **Secrets live in the macOS Keychain.** Only the tool's own process reads them, and it never puts them in an environment variable.
- **Repository code never runs in the tool's process.** The Gradle inventory runs the build under `codex sandbox` with the agent's write profile. Under that profile, checked on macOS, the Keychain isn't reachable, the sensitive home paths (`~/.ssh`, `~/.aws`, the Codex and Claude logins, shell startup files…) can't be read, and writes land only in the working copy, the temp dirs and the build cache. npm runs only `--package-lock-only --ignore-scripts`.
- **The Codex login source stays unreadable.** When a tool reuses a file-backed login, the sandbox denies the resolved `auth.json` and its canonical target when it is a symlink, including with a custom `CODEX_HOME`.
- **The agent edits a clone whose git metadata it can't write.** It can't commit or push. The `gh` and `git` guards on its PATH stop writes before they reach GitHub; they are guard rails, not a boundary.
- **The tool decides versions, verifies the result with this gate, and publishes.** Every write to a PR re-reads it first and stops unless it's still the tool's, at the expected head. Nothing merges by itself.
