# secure-it

Fixes what the [supply-chain gate](../ci)'s full scan fails on, at any depth, with the smallest change the version rule picks, batching non-major fixes and opening each major separately. The code decides versions and verifies the result; the tool writes npm files and a coding agent (Codex) applies non-npm edits and major adaptations.

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
   aged (own scopes: any age, or the proved required-dependency exception below), adding no advisory group or malware, and passing the gate's publisher identity check.
   Unchanged compatible peers stay at base; a companion may move downward within its line when necessary. All these
   choices use the security batch's same advisory snapshot, and each registry document is read once. An impossible
   set leaves the batch as blocked, with the conflicting peer ranges reported; unrelated fixes proceed. Unreadable
   locked manifests leave npm work blocked because incoming peer constraints cannot be ruled out.

   | Ecosystem | Situation | Mechanism |
   |---|---|---|
   | npm | a direct dependency | change its range and lock |
   | npm | a transitive one that every parent's range allows | lock exactly `to`, through temporary pins (a declaration for peers) |
   | npm | otherwise | a lasting override plus a floor entry |
   | Gradle | a declared dependency | change its version |
   | Gradle | a transitive one | a floor: an explicit dependency with `because(...)`, plus its entry in `.github/dependency-floors.json` |
   | Actions | any | pin to the tag's commit |
5. **Looks at its open PRs first.**
   - An open PR for the same routine/major/malware unit, with an identical plan and a recognised head: nothing to do; its review owns it. The unit reports `already-open`. Other major units still proceed. An already-open malware unit is left to review without planning other work.
   - One with a different plan, while its head is still the tool's: that PR is reconciled. The default branch is merged into it, every file it changed goes back to the base's content, and the new plan is applied on top, so nothing the old plan did lingers. It's pushed as a normal commit.
   - One someone else pushed to: the fix goes in a PR of its own.
6. **The tool resolves npm; the agent applies non-npm moves** (skill [`secure-it`](skills/secure-it/SKILL.md)). It changes code only for a major move, with `majorEffort`.
   npm may resolve transitive changes a planned move requires, under the supplied release-age window and exclusions.
   The tool resolves those versions; the agent never changes npm dependency fields or lockfiles. Direct
   dependencies outside the plan stay unchanged. Direct peers selected by code are explicit moves, even when they
   have no advisory themselves. New or purely transitive peers remain npm's resolution under `compare` unless they need the proved exception below.
   When a security target needs a version with no aged satisfier, code proves the registry requirement and pins its
   lowest stable, non-deprecated target exactly. This includes young direct-peer companions and recursive
   requirements; reciprocal direct peers are solved jointly at their resolved locations, and aged bridges are pinned
   when needed to preserve the proof. The gate independently validates every security root before reconstructing the
   batch's joint requirements; ordinary upgrades cannot narrow the proof's constraints. Parent, range, location, target and
   reason are recorded in the plan identity, PR and run report. Unsafe lowest versions, missing metadata, conflicting
   constraints or a proof bound block the unit. Existing compatibility pins remain constraints. Exact declarations
   support root/workspace anchors; placements the exact resolver cannot represent are reported without publication.
   A verification retry drops connected required sets together, leaving unrelated fixes.
   Other induced versions are npm's choice, not additional rule-picked targets: `compare` judges each changed version's advisories, age and identity. They may differ from another open
   PR's target; that PR doesn't constrain resolution. A failed comparison prevents publishing that edit rather than silently
   choosing a coupled target. The PR description lists required transitive changes too.
7. **Verifies before publishing** (`verify.ts`):
   - existing floor records and declarations are preserved before comparison: compatibility floors never change; security-floor updates match exact planned moves and retain their scope and history; only planned security floors may be added or removed in an explicit floor-removal plan;
   - the gate's own policy (its config, its exceptions, workflows and actions outside planned pins) is untouched, major or not;
   - `compare` against the base passes;
   - every move landed at exactly `to` at every planned location (Gradle: declared at exactly `to`);
   - none of the targeted advisories affects what's left, using compare's head findings from the same snapshot;
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

## Removing redundant security floors

A run also considers a separate **`floor-removal`** unit, after the security-fix units, unless malware remains on
base. Its draft PR uses `secure-it/<date>-floor-removal`. It never removes compatibility floors or mixes floor
removal with version fixes, and an open fix PR does not prevent this unit from running.

Each security floor first qualifies alone. The tool then resolves the whole candidate removal set **together,
without dependency locks**, and checks that every advisory recorded by every removed floor stays absent from all
resolved copies of that package. A failing joint result drops one implicated floor (or the last floor in deterministic
order for a resolution-wide error) and resolves the remainder again. Retained floors and their reasons appear in the
run report and the PR's plan notes. Incomplete inventories or advisory coverage cannot prove a removal.

- **npm:** an exported scratch copy loses the selected override versions and both adjacent lock formats
  (`package-lock.json` and `npm-shrinkwrap.json`). Sandboxed `npm install --package-lock-only --ignore-scripts`
  resolves under the configured release-age window and own-scope exclusions. Locked young base versions receive no
  special exemption in this unlocked proof. The tool writes the successful joint result's exact manifest and
  lockfile bytes; npm-only removal uses no agent.
- **Gradle:** a trusted init script removes only the selected exact advisory-bearing declarations from the selected
  configurations and disables dependency locking. Shared parent configurations stay intact. The inventory runs
  sandboxed with `--no-daemon` and configuration caching disabled. A declaration already used in resolution cannot
  be safely removed by this probe, so that floor is retained with a reason. After proof, the agent removes only the
  named declarations from the real build files; it cannot edit the tool-written floor/npm files or adapt code.

Before publication, verification requires exactly the planned records and declarations to disappear, preserves
all others and repository policy, and checks the recorded npm hashes. Unrelated direct versions and declarations
stay at base: if fresh npm resolution updates a direct parent, this unit fails verification rather than including
an unplanned parent bump. `compare` judges every induced version, and its head findings must still contain none of
the removed floors' advisories. No removal is published on a failed proof or verification.

Review recomputes the unlocked proof on a moved base and reconciles by reverting the old plan before applying the
new one. An unavailable or unsafe proof retains the PR and reports why; no floors remaining on base retires it.
Failed CI is reported without agent adaptation: the exact proved edit cannot be changed legitimately. The shared
review attempt budget still applies. An unchanged recognised plan reports `already-open`; a human-pushed PR is left
alone and any needed removal goes on a separate branch. Hidden plans record complete floor identities and file
hashes, never npm file contents.

## What a review does

The tick from [`packages/remediation`](../remediation), with secure-it's steps:

- **The base moved:**
  - The routine recomputes **the entire batch** on the new base, including newly actionable packages and retiring
    fixes the base now has. A major recomputes only its package's major unit. A unit with no actionable work is closed;
    blocked groups are reported. New malware on base prevents other units from verifying until it is fixed.
  - Older per-package plans without a batch kind keep their original package scope and topic during review. Runs
    create the new units independently; legacy PRs retire once their fixes are on the base.
  - A different plan on the new base: the PR is reconciled as in a run (reverted to the base, conflicts included, then the new plan applied), with the agent's new title and description.
  - The same plan: conflicted dependency files take the base's side, the tool re-writes npm files and the agent re-applies the non-npm plan; it also resolves any code conflicts.
  - A clean merge with the same plan also refreshes npm files before verification, without an agent. Matching npm floors keep their recorded date and reason; merged Gradle floor records remain intact.
  - Either way the result is verified like a run (including the one routine retry and visible omissions) and pushed, with the plan in the PR. Fixes remained on the new base, so an edit that leaves the base as it was fails verification; it doesn't retire the PR.
- **CI failed (version-fix units):** the agent adapts, at most twice, and the result is verified before it's pushed. CI and failing names come from the head SHA's Actions runs/jobs plus commit statuses; no Checks permission is needed.

## Isolation

- The tool's process reads its two tokens from the Keychain. It runs no repository code.
- The Gradle inventory runs under `codex sandbox` with the agent's write profile, the same sandbox the agent's commands run in. Under that profile, checked on macOS:
  - the Keychain isn't reachable;
  - the sensitive home paths can't be read;
  - writes land only in the working copy, the temp dirs and the build cache.
- npm dependency edits use `--package-lock-only --ignore-scripts`. Tool-run npm keeps the configured release-age window; agent check commands inherit it too. Planned young/unreadable targets and young/unreadable base versions in the affected lockfiles get explicit `--min-release-age-exclude` flags, alongside own-scope patterns. Each exclusion is reported; exact target checks and `compare` still judge all induced versions, including age and identity. This applies to initial edits, rebases/conflict resolution and CI adaptation, and requires npm >= 11.17.0 whenever exclusions are needed.
- npm 11.17.0 or later is required when an npm plan needs these exclusions. The tool checks the sandbox's npm before starting the agent and reports the required exclusions and detected version on failure.
- The agent gets the read-only token alone.

## Setup

See [Adopting the tools](../../docs/adopting-tools.md) for the first candidate preview, live run, Keychain
permissions and launchd schedules, and the [config reference](../../docs/tool-configuration.md) for every field.

- **Config:** `~/.config/leanish/secure-it/agent.yaml`. See the [config reference](../../docs/tool-configuration.md) for its fields.
- **Tokens:** two fine-grained tokens in the Keychain, default services `leanish-secure-it-write` and `leanish-secure-it-read`:
  - one that writes (Contents, Pull requests and Workflows: write; Actions, Commit statuses and Metadata: read);
  - a read-only one for the agent.

  Optional `secrets` overrides may share a pair with bump-it; every opted-in repo uses this pair, and write/read values must differ. PAT mode remains an alternative when GitHub App mode lands.
- **Tools:** Node 24, git, `gh`, and Codex, logged in; npm >= 11.17.0 when a planned npm fix or an own scope needs a release-age exclusion.
- **OSV-Scanner:** the version pinned in [`packages/ci/tools.json`](../ci/tools.json), installed into the tool's state directory (out of reach of sandboxed commands) and verified by sha256 before every run.
- **Schedule:** launchd or cron calls `run.sh`.


npm moves are written by the tool in a sandboxed export of base, before any agent work. All planned directs and
peer companions are pinned simultaneously to exact targets; unplanned directs keep base versions. The tool
installs, restores intended ranges and original manifest formatting, installs again, and requires exact landing.
Peer-resolved root/workspace copies use temporary exact declarations rather than overrides npm may ignore;
unsupported nested/conflicting placements are reported and nothing in that unit is published. Existing floors
remain, and new security overrides have matching floor records. Induced transitives remain npm's resolution under
the window and exclusions, judged by compare. The agent preserves computed locks and dependency fields; only a
major may adapt manifest scripts/config. Every apply, resolve and adapt path verifies those files before publishing.

Both skills accept omitted or null publication only for `cannot-apply`; an `applied` answer must include all PR text.
