# secure-it

Fixes what the [supply-chain gate](../ci)'s full scan fails on, at any depth, with the smallest change the version rule picks, and opens a draft PR for it. The code decides versions and verifies the result; a coding agent (Codex) only edits the working copy.

```bash
packages/remediation/run.sh secure-it run leanish/sqs-codec      # daily: fix one package
packages/remediation/run.sh secure-it review leanish/sqs-codec   # every few hours: look after its PRs
```

## What a run does

1. **Checks the daily scan still runs.** It warns when the default branch's last successful scheduled `supply-chain.yml` run is older than `staleScanHours` (default 36).
2. **Finds what fails.** It runs `candidates --rule security` on the default branch's head. The Gradle inventory runs the build, so it runs under the agent's sandbox (see below).
3. **Picks one package.** Every malicious package goes together, because a PR can't pass while any malware remains; if one can't move, none is attempted. Otherwise it takes the most severe package whose every failing version can move, every failing version at once. More severe packages that can't move whole (no fixing version, an identity break) are listed in the report. Advisories no version fixes stay, inherited.
4. **Plans the change** (`plan.ts`), for each version and location:

   | Ecosystem | Situation | Mechanism |
   |---|---|---|
   | npm | a direct dependency | change its range and lock |
   | npm | a transitive one that every parent's range allows | lock at exactly `to`, through a temporary override |
   | npm | otherwise | a lasting override plus a floor entry |
   | Gradle | a declared dependency | change its version |
   | Gradle | a transitive one | a floor: an explicit dependency with `because(...)`, plus its entry in `.github/dependency-floors.json` |
   | Actions | any | pin to the tag's commit |
5. **Looks at its open PRs first.**
   - An open secure-it PR with the same plan: nothing to do, its review owns it.
   - One with a different plan, while its head is still the tool's: that PR is reconciled. The default branch is merged into it, every file it changed goes back to the base's content, and the new plan is applied on top, so nothing the old plan did lingers. It's pushed as a normal commit.
   - One someone else pushed to: the fix goes in a PR of its own.
6. **The agent applies the plan** (skill [`secure-it`](skills/secure-it/SKILL.md)). It changes code only for a major move, with `majorEffort`.
7. **Verifies before publishing** (`verify.ts`):
   - the gate's own policy (its config, its exceptions, workflows and actions outside planned pins) is untouched, major or not;
   - `compare` against the base passes;
   - every move landed at exactly `to` at every planned location (Gradle: declared at exactly `to`);
   - none of the targeted advisories affects what's left;
   - no other direct dependency or action use changed;
   - only dependency files changed, unless a move is a major.

   Any failure: nothing is published.
8. **Publishes** a draft PR, `secure-it/<date>-<package>`, with the agent's description and a table of the moves. The plan is also embedded in the PR body for later runs.

## What a review does

The tick from [`packages/remediation`](../remediation), with secure-it's steps:

- **The base moved:**
  - The fix is recomputed on the new base first. If the base already has it, the PR is closed.
  - A different plan on the new base: the PR is reconciled as in a run (reverted to the base, conflicts included, then the new plan applied), with the agent's new title and description.
  - The same plan: conflicted dependency files take the base's side, and the agent re-applies the plan; it also resolves any code conflicts.
  - Either way the result is verified like a run and pushed, with the plan in the PR. Fixes remained on the new base, so an edit that leaves the base as it was fails verification; it doesn't retire the PR.
- **CI failed:** the agent adapts, at most twice, and the result is verified before it's pushed.

## Isolation

- The tool's process reads its two tokens from the Keychain. It runs no repository code.
- The Gradle inventory runs under `codex sandbox` with the agent's write profile, the same sandbox the agent's commands run in. Under that profile, checked on macOS:
  - the Keychain isn't reachable;
  - the sensitive home paths can't be read;
  - writes land only in the working copy, the temp dirs and the build cache.
- npm runs only `--package-lock-only --ignore-scripts`.
- The agent gets the read-only token alone.

## Setup

- **Config:** `~/.config/leanish/secure-it/agent.yaml`. See [`packages/remediation`](../remediation) for its fields.
- **Tokens:** two fine-grained tokens in the Keychain:
  - one that writes (Contents, Pull requests and Workflows: write; Actions, Commit statuses and Metadata: read);
  - a read-only one for the agent.
- **Tools:** Node 24, git, `gh`, and Codex, logged in.
- **OSV-Scanner:** the version pinned in [`packages/ci/tools.json`](../ci/tools.json), installed into the tool's state directory (out of reach of sandboxed commands) and verified by sha256 before every run.
- **Schedule:** launchd or cron calls `run.sh`.
