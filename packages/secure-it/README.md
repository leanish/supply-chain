# secure-it

Fixes what the [supply-chain gate](../ci)'s full scan fails on, at any depth, with the smallest change the version rule picks, batching non-major fixes and opening each major separately. The code decides versions and verifies the result; a coding agent (Codex) only edits the working copy.

```bash
packages/remediation/run.sh secure-it run leanish/sqs-codec      # daily: batch fixes, majors apart
packages/remediation/run.sh secure-it review leanish/sqs-codec   # every few hours: look after its PRs
```

## What a run does

1. **Checks the daily scan still runs.** It warns when the default branch's last successful scheduled `supply-chain.yml` run is older than `staleScanHours` (default 36).
2. **Finds what fails.** It runs `candidates --rule security` on the default branch's head. The Gradle inventory runs the build, so it runs under the agent's sandbox (see below).
3. **Groups actionable fixes.**
   - Every non-major package goes in one routine security batch, across npm, Gradle and Actions.
   - Each package needing a major gets its own PR, with `majorEffort`. A package's failing copies stay together: if
     any copy needs a major, all its actionable copies go in that major unit rather than splitting the package.
   - A package with a blocked copy (no fix or an identity break) is left out and reported, without blocking other
     packages. Keeping copies together preserves verification's requirement that targeted advisories affect no
     version of a planned package left in the tree. Advisories no version fixes stay, inherited.
   - Malware takes priority: every malicious package goes together, and if any malicious fix cannot move, nothing
     else is planned. No other unit runs while malware remains on the base.
4. **Plans the change** (`plan.ts`), for each version and location. For npm, code reads locked and candidate manifests
   to find direct peer constraints in either direction. Rule-picked security targets stay fixed. A direct that must
   move with them gets the lowest safe version in its own compatible line that makes the connected set consistent:
   aged (own scopes: any age), adding no advisory group or malware, and passing the gate's publisher identity check.
   Unchanged compatible peers stay at base; a companion may move downward within its line when necessary. All these
   choices use the security batch's same advisory snapshot, and each registry document is read once. An impossible
   set leaves the batch as blocked, with the conflicting peer ranges reported; unrelated fixes proceed. Unreadable
   locked manifests leave npm work blocked because incoming peer constraints cannot be ruled out.

   | Ecosystem | Situation | Mechanism |
   |---|---|---|
   | npm | a direct dependency | change its range and lock |
   | npm | a transitive one that every parent's range allows | lock at exactly `to`, through a temporary override |
   | npm | otherwise | a lasting override plus a floor entry |
   | Gradle | a declared dependency | change its version |
   | Gradle | a transitive one | a floor: an explicit dependency with `because(...)`, plus its entry in `.github/dependency-floors.json` |
   | Actions | any | pin to the tag's commit |
5. **Looks at its open PRs first.**
   - An open PR for the same routine/major/malware unit, with an identical plan and a recognised head: nothing to do; its review owns it. The unit reports `already-open`. Other major units still proceed. An already-open malware unit is left to review without planning other work.
   - One with a different plan, while its head is still the tool's: that PR is reconciled. The default branch is merged into it, every file it changed goes back to the base's content, and the new plan is applied on top, so nothing the old plan did lingers. It's pushed as a normal commit.
   - One someone else pushed to: the fix goes in a PR of its own.
6. **The agent applies the plan** (skill [`secure-it`](skills/secure-it/SKILL.md)). It changes code only for a major move, with `majorEffort`.
   npm may resolve transitive changes a planned move requires, under the supplied release-age window and exclusions.
   The agent does not hand-edit those versions, add unplanned overrides, or refresh unrelated packages. Direct
   dependencies outside the plan stay unchanged. Direct peers selected by code are explicit moves, even when they
   have no advisory themselves. New or purely transitive peers remain npm's resolution under `compare`.
   These induced versions are npm's choice, not additional rule-picked
   targets: `compare` judges each changed version's advisories, age and identity. They may differ from another open
   PR's target; that PR doesn't constrain resolution. A failed comparison prevents publishing that edit rather than silently
   choosing a coupled target. The PR description lists required transitive changes too.
7. **Verifies before publishing** (`verify.ts`):
   - the gate's own policy (its config, its exceptions, workflows and actions outside planned pins) is untouched, major or not;
   - `compare` against the base passes;
   - every move landed at exactly `to` at every planned location (Gradle: declared at exactly `to`);
   - none of the targeted advisories affects what's left;
   - no other direct dependency or action use changed;
   - only dependency files changed, unless a move is a major.

   A routine batch that fails verification may retry **once**, from the original base, without the whole package
   groups named by its problems, including their whole connected direct-peer set. Every problem must identify a
   planned move through a version-labelled finding or
   a named landing/declaration failure. A global or unplanned induced-transitive failure cannot identify a parent
   safely, so it gets no reduction. If no moves remain, or the second verification fails, nothing is published.
   Malware and major units are never reduced. Omitted moves and the original problems appear in the run report,
   the PR description and its persisted plan; only the remaining moves are claimed as applied. npm may still induce
   transitive changes, and these still face `compare`. The next run reconsiders omitted fixes.
8. **Publishes** draft PRs: `secure-it/<date>-security` for the routine, `secure-it/<date>-<package>-major` for each
   major, or `secure-it/<date>-malware`. Each unit starts from the scanned base and publishes at most one new or
   updated PR. A failed unit is reported and doesn't stop other major units. The agent's description carries the
   move table and hidden plan for later runs. Multi-unit reports use `units`; a single unit keeps its outcome at the
   top level too.

## What a review does

The tick from [`packages/remediation`](../remediation), with secure-it's steps:

- **The base moved:**
  - The routine recomputes **the entire batch** on the new base, including newly actionable packages and retiring
    fixes the base now has. A major recomputes only its package's major unit. A unit with no actionable work is closed;
    blocked groups are reported. New malware on base prevents other units from verifying until it is fixed.
  - Older per-package plans without a batch kind keep their original package scope and topic during review. Runs
    create the new units independently; legacy PRs retire once their fixes are on the base.
  - A different plan on the new base: the PR is reconciled as in a run (reverted to the base, conflicts included, then the new plan applied), with the agent's new title and description.
  - The same plan: conflicted dependency files take the base's side, and the agent re-applies the plan; it also resolves any code conflicts.
  - Either way the result is verified like a run (including the one routine retry and visible omissions) and pushed, with the plan in the PR. Fixes remained on the new base, so an edit that leaves the base as it was fails verification; it doesn't retire the PR.
- **CI failed:** the agent adapts, at most twice, and the result is verified before it's pushed. CI and failing names come from the head SHA's Actions runs/jobs plus commit statuses; no Checks permission is needed.

## Isolation

- The tool's process reads its two tokens from the Keychain. It runs no repository code.
- The Gradle inventory runs under `codex sandbox` with the agent's write profile, the same sandbox the agent's commands run in. Under that profile, checked on macOS:
  - the Keychain isn't reachable;
  - the sensitive home paths can't be read;
  - writes land only in the working copy, the temp dirs and the build cache.
- npm dependency edits use `--package-lock-only --ignore-scripts`. The agent keeps the configured release-age window. Planned packages whose target is young (or its publish time cannot be read) get explicit `--min-release-age-exclude` flags, alongside the own-scope patterns. Other packages keep the window; verification still requires the exact planned targets and `compare` passes. This applies to initial edits, rebases/conflict resolution and CI adaptation.
- npm 11.17.0 or later is required when an npm plan needs these exclusions. The tool checks the sandbox's npm before starting the agent and reports the required exclusions and detected version on failure.
- The agent gets the read-only token alone.

## Setup

- **Config:** `~/.config/leanish/secure-it/agent.yaml`. See [`packages/remediation`](../remediation) for its fields.
- **Tokens:** two fine-grained tokens in the Keychain:
  - one that writes (Contents, Pull requests and Workflows: write; Actions, Commit statuses and Metadata: read);
  - a read-only one for the agent.
- **Tools:** Node 24, git, `gh`, and Codex, logged in; npm >= 11.17.0 when a planned npm fix or an own scope needs a release-age exclusion.
- **OSV-Scanner:** the version pinned in [`packages/ci/tools.json`](../ci/tools.json), installed into the tool's state directory (out of reach of sandboxed commands) and verified by sha256 before every run.
- **Schedule:** launchd or cron calls `run.sh`.
