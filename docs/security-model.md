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

## secure-it and bump-it (planned; not in this tree yet)

What they're designed to do:

- Each tool will hold two GitHub credentials: one that writes (branches, PRs, comments) for the tool's own process, one read-only for the coding agent. With a GitHub App, the tool mints both from the App's key, which the agent never sees; with personal access tokens, two fine-grained tokens.
- Secrets will live in the operating system's store (macOS Keychain first), not in files the agent can read.
- The agent edits a clone; the tool decides versions, verifies the result with this gate, and publishes. Nothing merges by itself.
