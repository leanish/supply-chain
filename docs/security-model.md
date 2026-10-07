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

Both tools are in this tree: [`secure-it`](../packages/secure-it) and [`bump-it`](../packages/bump-it), using [`packages/remediation`](../packages/remediation).

- **Two GitHub tokens per tool**, both personal access tokens for now (a GitHub App mode is planned):
  - one that writes (branches, PRs, comments), only for the tool's own process;
  - one read-only, which the coding agent gets as `GH_TOKEN`.

  The tool refuses two Keychain items holding the same token.
- **Secrets live in the macOS Keychain.** Only the tool's own process reads them, and it never puts them in an environment variable.
- **Repository code never runs in the tool's process.** The Gradle inventory runs the build under `codex sandbox` with the agent's write profile. Under that profile, checked on macOS, the Keychain isn't reachable, the sensitive home paths (`~/.ssh`, `~/.aws`, the Codex and Claude logins, shell startup files…) can't be read, and writes land only in the working copy, the temp dirs and the build cache. bump-it computes npm changes in exported scratch copies under the same sandbox, with `--package-lock-only --ignore-scripts`, explicit release-age flags and own-scope exclusions. The tool protects exact lockfile bytes and manifest dependency fields; only major migrations may adapt other manifest fields.
- **Young security targets do not disable npm's age window.** secure-it explicitly excludes only planned packages whose target is young or whose publish time cannot be read, retaining configured own-scope exclusions. It checks sandboxed npm >= 11.17.0 before the agent uses these flags in any editing mode. Every other package keeps the window; exact target verification and `compare` still gate publication.
- **PR CI reads use Actions and commit statuses.** The tools read workflow runs/jobs for the head SHA and the combined commit status, including their failure names for adaptation. No Checks API permission is required. Results from other apps must be published as commit statuses to be visible.
- **Tool-run Gradle builds never reuse an existing daemon.** Every inventory passes `--no-daemon` (CI, exported base and working tree): any required daemon is single-use. A sandboxed inventory starts it inside the current build's sandbox; a reused daemon would retain the permissions of the sandbox that started it. The inventory is the tools' only Gradle build entrypoint, so no later tool build connects to daemons left in the shared `GRADLE_USER_HOME` by an agent or another build. Agent commands may still start or reuse daemons; inventories never connect to them. This uses the explicit Gradle flag rather than changing `GRADLE_OPTS`, `org.gradle.jvmargs` or repository properties.
- **The agent edits a clone whose git metadata it can't write.** It can't commit or push. The `gh` and `git` guards on its PATH stop writes before they reach GitHub; they are guard rails, not a boundary.
- **The tool decides versions, verifies the result with this gate, and publishes.** Every write to a PR re-reads it first and stops unless it's still the tool's, at the expected head. Nothing merges by itself.
