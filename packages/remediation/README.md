# remediation

What secure-it and bump-it share. Each tool is its own command with its own config, schedule, skill and PRs; this
package is the code around them. See [Adopting the tools](../../docs/adopting-tools.md) and the
[config reference](../../docs/tool-configuration.md) for setup and complete examples:

- **Config** (`config.ts`): `~/.config/leanish/<tool>/agent.yaml`, read strictly (unknown fields fail). It holds:
  - the repositories, each an explicit opt-in;
  - the coding agent, model and efforts (`majorEffort` for majors and their reviews);
  - optional Keychain service overrides (defaults: `leanish-<tool>-write` and `leanish-<tool>-read`, for the tool's write token and the agent's read-only one);
  - the commit identity, the state and cache directories, and paths the agent may not read;
  - for secure-it, `staleScanHours`; for bump-it, `maxNewMajorsPerRun` (default 3, new majors only).

  Every opted-in repository uses the tool's pair of Keychain items. Both tools may share a pair through overrides; write and read must still be distinct names and token values. PAT mode remains an alternative when GitHub App mode lands. What's about the repository (release age, own packages, registries) comes from its `.github/supply-chain.json`.
- **The tool's PRs** (`own-pr.ts`, `publication.ts`):
  - **Recognition:** a PR is the tool's when it comes from one of its branches (`<tool>/<date>-<topic>`) of the repository itself and carries its body marker or its label (`leanish:<tool>`). Legacy `leanish:agent=<tool>` labels are still recognised. New publications and updates add the current label without removing the legacy one; body markers stay unchanged.
  - **State:** the body records the head the tool pushed, the base it computed against, and how many times the agent adapted it.
  - **Race checks:** every write re-reads the PR first and stops unless it's still the tool's, open, and at the expected head.
  - **Journal** (`journal.ts`): before each update push, the tool records the head/base, matching title and full body (plan included), and adaptation count in its state directory. If the body update fails, the next run or review recognises the tool's exact head and restores that whole publication before reuse or CI handling. A legacy head/base-only recovery forces recomputation and verified republication in a run; review refuses readiness or adaptation until then.
- **The review tick** (`review.ts`) goes through every open PR of the tool, in this order:
  1. Someone else pushed: leave the PR alone.
  2. The base moved: the tool recomputes on the new base, before anything else, with the base merged in or the conflicting merge left in progress for it to resolve.
  3. CI comes from the head SHA's Actions workflow runs/jobs and commit statuses (Actions and Commit statuses: read; no Checks permission). Checks-only results from other apps are not read. CI pending: nothing. Green: mark the PR ready. No model is used for 1 or 3.
  4. CI failed: version-fix secure-it units and bump-it majors can adapt, at most twice, each attempt counted before it starts. bump-it routines and floor-removal units report failures without an agent; the shared attempt budget still applies. After exhaustion, the PR is closed with a comment.

  A problem with one PR doesn't stop the others.
- **The command** (`command.ts`): `<tool> run|review <owner/repo> [--config <file>]`. It reads both tokens from the resolved default or overridden Keychain services and refuses identical ones. It syncs the working copy and runs the agent isolated, giving it only the read-only token. It always ends with one `run finished` line on stderr, and tells run.sh once that line is out.
- **Repository code under the sandbox** (`sandboxed.ts`): a command that runs the repository's code, such as the Gradle inventory, runs under `codex sandbox` with the agent's write profile. It can't reach the Keychain or the sensitive home paths, and it writes only to the working copy, the temp dirs and the build cache. Tool-run Gradle builds always use `--no-daemon`, so they never connect to an existing daemon with another sandbox's permissions. Inventories, wrapper generation and unlocked floor probes ignore daemons left by agent commands. `GRADLE_OPTS` and repository JVM settings are left intact.
- **Git copies** (`git-copies.ts`): a commit's files exported to a temporary directory (to inventory a commit the working copy doesn't have checked out), and what the working tree changed since a commit. These are read-only git commands on the git metadata the workspace created.
- **OSV-Scanner** (`osv-scanner.ts`): the version `packages/ci/tools.json` pins, installed into protected tool state by CI's installer and checked by sha256 before every use.
- **`run.sh`**: `run.sh <tool> run|review <owner/repo>`, what launchd or cron calls. It takes one lock per tool and repository (exit 75 while another run holds it), and writes the final line itself when it stops before the tool reports.

Parts adapted from leanish-development's bump-it are listed in [PROVENANCE.md](PROVENANCE.md).
