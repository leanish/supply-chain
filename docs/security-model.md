# Security model

What can run where, and which credential it can reach.

## The CI gate

| Job | Runs code from the checked repository | Token | Writes |
|---|---|---|---|
| `inventory` (PRs, `main`) | yes: Gradle runs the build to learn what it resolves | `contents: read` (fork PRs: read-only regardless) | the inventory file, as an artifact |
| `supply-chain` (the verdict) | no: lockfiles and workflows are read from git objects, the Gradle inventory as data | `contents: read` | its report |
| `rescan-plan` | no | `pull-requests: read` | the list of PRs |
| `rescan-inventory` (one per open PR) | yes: the base's build, then the PR's | `contents: read`, passed only to the one `git fetch` that needs it | the two inventories (base first, uploaded before PR code runs) |
| `rescan` | no | `statuses: write`, `pull-requests: read` | commit statuses on PR heads |

- **No checkout keeps credentials** (`persist-credentials: false`), so the build can't find a token in `.git/config`.
- **The tools that read the repository's own configuration get no token.** npm and the Gradle wrapper run with `GITHUB_TOKEN`, `GH_TOKEN` and the Actions runtime tokens removed from their environment: a PR's `.npmrc` can expand environment variables, and the build is the repository's code. git only reads the checkout (`show`, `ls-tree`), except the rescan's one fetch, which gets the token as a header for that command alone.
- **The verdict never leaves the job that computes it.** The PR job's result is its check; the daily `rescan` job posts statuses itself, so no artifact another job uploads can stand in for a verdict.
- **What a build can still do:** Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory (hide a dependency from it). The job split keeps it from touching the comparison and the publishing credentials, not from lying about itself; review build changes. A PR's build could also upload an artifact under another PR's name in the daily rescan (both are PR-controlled data).
- **Fork PRs** run the workflow from the fork's own files, with a read-only token and no secrets: their check is only as trustworthy as the PR. The daily rescan, which runs this repository's workflow from the default branch, gives them a trusted status; see the adoption guide in [`packages/ci/README.md`](../packages/ci/README.md).

## The gate itself

- It's pinned to one full commit SHA, and checked out from that same commit.
- OSV-Scanner is pinned by version and sha256 ([`packages/ci/tools.json`](../packages/ci/tools.json)).
- Its one runtime dependency (`yaml`) installs from this repository's lockfile, without lifecycle scripts.
- It fails closed: an unreachable registry, OSV or GitHub API, data that doesn't parse, a build that didn't resolve, or a rescan that didn't complete is a failure, never "clean".

## secure-it and bump-it (being built)

- Each tool holds two GitHub credentials: one that writes (branches, PRs, comments) for the tool's own process, one read-only for the coding agent. With a GitHub App, the tool mints both from the App's key, which the agent never sees; with personal access tokens, two fine-grained tokens.
- Secrets live in the operating system's store (macOS Keychain today), not in files the agent can read.
- The agent edits a clone; the tool decides versions, verifies the result with this gate, and publishes. Nothing merges by itself.
