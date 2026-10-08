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
- **Repository build commands get no token.** The Gradle wrapper runs with `GITHUB_TOKEN`, `GH_TOKEN` and the Actions runtime tokens removed from its environment. npm signature verification instead uses the clean projects and fixed configuration described below. git only reads the checkout (`show`, `ls-tree`), except the rescan's one fetch, which gets the token as a header for that command alone.
- **The verdict never leaves the job that computes it.** The PR job's result is its check; the daily `rescan` job posts statuses itself, so no artifact another job uploads can stand in for a verdict.
- **What a build can still do:** Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory (hide a dependency from it). The job split keeps it from touching the comparison and the publishing credentials, not from lying about itself; review build changes. A PR's build could also upload an artifact under another PR's name in the daily rescan (both are PR-controlled data).
- **Fork PRs** run the workflow from the fork's own files, with a read-only token and no secrets: their check is only as trustworthy as the PR. The daily rescan, which runs this repository's workflow from the default branch, gives them a trusted status; see the adoption guide in [`packages/ci/README.md`](../packages/ci/README.md).

### npm signature verification

Both the PR job and the rescan publisher use the gate's `npm-signatures` command. The publisher invokes it only after comparison completes with a passing verdict; a rejected source or any other comparison failure skips npm entirely.

For each configured npm lockfile, the verifier creates a fresh temporary project containing only that lockfile and the root and workspace `package.json` files. Workspace paths and links must stay within the staged project; only the root discovers workspaces, using an explicit list of staged directories instead of globs. An adjacent `npm-shrinkwrap.json` cannot replace the selected lockfile. Repository `.npmrc` files, executables and installed modules are never copied.

The publisher runs the trusted runner's npm twice: `npm ci` followed by `npm audit signatures`. Both commands use a fixed project prefix, `--ignore-scripts`, `--bin-links=false`, `--git=/usr/bin/false`, `--userconfig=/dev/null`, a separate empty global config, and a fresh cache and home. The child environment contains only the runner's command path, locale and platform variables plus those temporary directories. Tokens, `NODE_OPTIONS`, npm configuration variables and proxy variables are not inherited. Project configuration cannot select a Git executable, inject a registry or proxy override, or enable lifecycle scripts.

Registry flags come only from the gate's `npm.registries` configuration (HTTP(S), without embedded credentials). The first allowed registry is the default; scoped packages use the allowed registry recorded in their lockfile sources. Conflicting registries for the same scope fail. Git dependencies, tarball URL dependency specifiers and external file dependencies are refused; local links are permitted only for staged workspaces. Locked registry sources are checked again before invoking npm. The fixed Git executable also refuses Git access if npm encounters a specifier not covered by those checks.

Temporary projects, homes and caches are removed on success or failure. This boundary prevents repository-selected executable execution; it is not an operating-system sandbox for npm itself. It trusts the runner's Node/npm installation and the registry archive handling and signature-verification implementation in npm. Private registry credentials and repository-specific proxy settings are deliberately unavailable to this verifier.

## The gate itself

- It's pinned to one full commit SHA, and checked out from that same commit.
- OSV-Scanner is pinned by version and sha256 ([`packages/ci/tools.json`](../packages/ci/tools.json)).
- Its runtime dependencies (`yaml` and `semver`) install from this repository's lockfile, without lifecycle scripts. A smoke test installs only the CI workspace's production dependencies and loads its CLI.
- It fails closed on what it needs to judge: an unreachable registry, OSV or GitHub API, data that doesn't parse, or a build that didn't resolve fails the check, never "clean". What it can't read but doesn't need to judge (a source repository's advisories that return 404, a range it can't parse) is a coverage gap: listed in the report, next to a verdict that can pass.
- In the daily rescan, a PR whose inventories or comparison didn't complete gets a failure status. If the rescan can't plan at all (the GitHub API fails before it lists the PRs), it posts nothing: the PRs keep their last status, and the workflow run fails.

## secure-it and bump-it

Both tools are in this tree: [`secure-it`](../packages/secure-it) and [`bump-it`](../packages/bump-it), using [`packages/remediation`](../packages/remediation).

- **Two GitHub tokens per tool**, both personal access tokens for now (PAT mode will remain an alternative when the planned GitHub App mode lands):
  - one that writes (branches, PRs, comments), only for the tool's own process;
  - one read-only, which the coding agent gets as `GH_TOKEN`.

  The tool refuses two Keychain items holding the same token. The default services are `leanish-<tool>-write` and `leanish-<tool>-read`; optional `secrets` overrides may point both tools to the same pair. Every opted-in repository uses that pair, with no per-repository secrets.
- **Secrets live in the macOS Keychain.** Only the tool's own process reads them, and it never puts them in an environment variable.
- **Repository code never runs in the tool's process.** The Gradle inventory runs the build under `codex sandbox` with the agent's write profile. Under that profile, checked on macOS, the Keychain isn't reachable, the sensitive home paths (`~/.ssh`, `~/.aws`, the Codex and Claude logins, shell startup files…) can't be read, and writes land only in the working copy, the temp dirs and the build cache. bump-it computes npm changes in exported scratch copies under the same sandbox, with `--package-lock-only --ignore-scripts`, explicit release-age flags and own-scope exclusions. The tool protects exact lockfile bytes and manifest dependency fields; only major migrations may adapt other manifest fields.
- **The Codex login source stays unreadable.** When a tool reuses a file-backed login, the sandbox denies the resolved `auth.json` and its canonical target when it is a symlink, including with a custom `CODEX_HOME`.
- **npm's age exclusions do not waive verification.** secure-it excludes planned young or unreadable targets, plus young or unreadable versions already locked in the affected base lockfiles, retaining configured own-scope exclusions. This lets npm keep unrelated locked security fixes. It checks sandboxed npm >= 11.17.0 before the agent uses these flags in any editing mode. Every exclusion is reported; exact target verification and `compare` still judge all induced changes, including their age and identity.
- **PR CI reads use Actions and commit statuses.** The tools read workflow runs/jobs for the head SHA and the combined commit status, including their failure names for adaptation. No Checks API permission is required. Results from other apps must be published as commit statuses to be visible.
- **Tool-run Gradle builds never reuse an existing daemon.** Every inventory and tool-run wrapper task passes `--no-daemon` (CI, exported base and working tree): any required daemon is single-use. A sandboxed inventory starts it inside the current build's sandbox; a reused daemon would retain the permissions of the sandbox that started it. Neither inventories nor wrapper generation connects to daemons left in the shared `GRADLE_USER_HOME` by an agent or another build. Agent commands may still start or reuse daemons; tool-run Gradle commands never connect to them. This uses the explicit Gradle flag rather than changing `GRADLE_OPTS`, `org.gradle.jvmargs` or repository properties.
- **Gradle wrapper generation stays in the tool's sandbox.** bump-it reads services.gradle.org's release metadata
  and checksums and one snapshot of gradle/gradle's published advisories. The tool runs the wrapper task twice under
  `runSandboxed` with `--no-daemon`, in an exported base commit; the model does not generate or edit wrapper files.
  Changes outside the four wrapper files (tracked or non-ignored files) reject generation. Ignored cache/build
  output is discarded with the scratch copy. The tool copies the generated bytes into the working tree and records
  all four hashes and executable modes in the plan. Verification, after the sandboxed inventory, checks those bytes
  and modes plus the official distribution URL/checksum and jar SHA-256. Missing recorded hashes fail closed.
  Wrapper planning errors are reported omissions; planned-wrapper verification errors block publication. Generated
  scripts are protected against later agent edits, rather than independently compared with official scripts.
- **The agent edits a clone whose git metadata it can't write.** It can't commit or push. The `gh` and `git` guards on its PATH stop writes before they reach GitHub; they are guard rails, not a boundary.
- **The tool decides versions, verifies the result with this gate, and publishes.** Every write to a PR re-reads it first and stops unless it's still the tool's, at the expected head. Nothing merges by itself.
- **Floor history stays intact.** secure-it compares recorded floors and their declarations before `compare`: compatibility floors never change, and security floors change only at exact planned targets with their scope and history preserved. New floors must be planned security additions. Only a dedicated floor-removal plan may remove exact recorded security floors; compatibility records and declarations remain intact. Remaining target advisories are checked using the head findings from compare's same snapshot.
- **Floor removal requires a joint unlocked proof.** secure-it exports the base into sandboxed scratch copies.
  npm resolves without either adjacent lock format, without lifecycle scripts, under the configured window and own
  scopes. Gradle uses a trusted init script to filter exact advisory-bearing floor declarations and disable
  dependency locks, with `--no-daemon` and no configuration cache. All selected floors must stay fixed in one joint
  resolution; incomplete data retains them. The tool writes exact npm/floor bytes; the agent only removes named
  Gradle declarations. Final verification preserves policy, compatibility floors and unrelated direct declarations,
  checks the planned npm hashes, and uses compare's head findings to reject any remaining target advisory.
  Gradle still runs repository code and can misrepresent its own inventory, as documented above; this proof does
  not create an independent Gradle resolver.
- **A push and its plan recover together.** Before updating a PR branch, the tool journals the intended head/base, title, full body (including the plan), and adaptation count. If the body update fails after the push, the next run or review restores that exact content with a guarded re-read. A legacy head/base-only recovery forces recomputation and verified republication in a run; review refuses readiness or adaptation until then.
