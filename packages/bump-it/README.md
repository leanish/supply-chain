# bump-it

Keeps dependencies fresh with the supply-chain gate's version rule: the highest eligible version at least seven days
old (or the repository's `releaseAgeDays`), adding no advisory group or malware. Packages in the repository's own npm
scopes skip the wait (their dependencies don't).
Actions pins and Dockerfile CLIs represented by configured npm manifest/lockfiles use the same rule.
The tool decides versions, computes npm files and verifies every edit before opening a draft PR. The coding agent
handles Gradle declarations, Actions pins and major migrations.

```bash
packages/remediation/run.sh bump-it run leanish/widget      # weekly
packages/remediation/run.sh bump-it review leanish/widget   # every few hours
```

## Run

- Inventory the default branch, with Gradle builds in the sandbox. An incomplete inventory stops the run.
- One routine PR contains all selected direct minor/patch moves and the npm transitive refresh. Each major gets its own
  PR, including every declaration of that package with a selected major move. Each unit starts from the default branch,
  and a unit's failure does not stop others. Gradle transitives are never explicitly moved; induced changes are judged
  by `compare`. Recorded security and compatibility floors stay untouched.
- `@types/node` targets never exceed the lowest supported Node major found in `engines.node`, `.nvmrc`,
  `.node-version`, `volta.node`, or static `actions/setup-node` CI versions (including matrices). Root, lockfile-root
  and declaring-workspace constraints are combined by taking the minimum; a newer development or CI runtime never
  raises an older support floor. This applies to direct peer companions, the routine transitive refresh, and copies
  induced by major updates.
  npm-selected incompatible copies are re-locked to eligible versions within their parents' ranges; if no safe
  resolution exists, the unit fails before publication. All workspace runtime constraints are included.
  If none is readable, only updates within the current type major are allowed and the run reports why majors were
  withheld. A newly introduced type copy also requires readable runtime evidence. Floating aliases and unresolved
  CI expressions do not establish a support floor. An existing type major
  above the runtime is left for a manual correction; bump-it does not raise it further or silently downgrade it.
- The root Gradle wrapper joins the routine within its current major; the highest eligible newer major gets its own
  `gradle-gradle-major` PR, subject to the same new-major cap and deferred priority. Code picks stable, non-broken
  services.gradle.org releases at least `releaseAgeDays` old by `buildTime`. Published gradle/gradle repository
  advisories are read once per run/tick: inherited advisories do not veto a candidate, but any newly affecting
  advisory does. Release timestamps include their signed UTC offset; an invalid timestamp skips only that release,
  with a reason in run results and plan notes. A rejected newer release does not veto an older eligible one.
  Missing metadata or unreadable
  advisory ranges leave the wrapper out with a reported reason; other moves continue.
  Advisory reading supports inclusive `to`/`through` ranges, bracketed intervals and wildcard upper lines,
  plus lists of maintenance-line fixes. An unknown advisory range omits the entire wrapper selection: without
  readable bounds, code cannot prove which versions it might affect. Verification of a planned wrapper fails closed.
- Before npm resolves a routine or major, code checks incoming and outgoing peer constraints against existing directs.
  Rule-picked bump targets stay fixed; required companions are added explicitly at the lowest safe version in their
  own compatible line that makes the set consistent, aged (own scopes: any age), with no new advisory group, malware
  or rejected publisher identity. Compatible peers stay at base; a needed companion may move downward within its line.
  One peer snapshot judges the fixed targets and all companions together. Impossible sets or repository constraints
  that exclude a companion are reported and left out, while unrelated routine moves continue. Unreadable locked peer
  metadata blocks npm moves because incoming constraints cannot be ruled out. New or purely transitive peers stay
  with npm resolution and `compare`. A major's PR still belongs to its primary package and counts as one new major.
- npm resolution runs in an exported scratch copy, under `codex sandbox`, with `--package-lock-only --ignore-scripts`,
  the release-age window and own-scope exclusions on every install/update. Packages with a young locked base version
  in any lockfile this unit computes also get a named npm age exclusion, so npm can keep the version already locked;
  unreadable publish times are treated as young. Each exclusion is reported. Publish-time lookups are cached and shared
  with target selection: bump-it's targets still require the age, and `compare` judges what a major induces.
  The routine resolves after direct updates,
  then code weighs all transitive candidates within the dependents' ranges and existing override constraints on one
  advisory snapshot. Direct targets and frozen directs are constrained with simultaneous temporary exact declarations before the
  first install/update. Peer copies at a root/workspace are anchored with exact declarations, not ignored overrides;
  unsupported nested/conflicting placements block that unit with a reason. Temporary pins lock targets, restoring
  planned manifest bytes before a second install. The final graph must keep every target (at most four pin passes). Majors install their own move without a
  routine refresh, installing any explicit peer companions too; direct declarations outside the plan remain at base.
- Unjudgeable copies stay at their base version, with an unresolved note. Complex scoped override rules are treated
  conservatively: their copies stay at base rather than claiming an R3 selection. If a new copy has no provable eligible
  target, or npm cannot retain a required target, that unit fails. Exact repository pins are reported separately as pins.
- The agent never changes npm dependency fields or lockfiles. The tool-written graph already includes refreshed or
  induced transitives, even when those versions are absent from the explicit move list; the agent preserves them.
  It may adapt code and manifest scripts/config only for a major, using `majorEffort` (configure Sol with high effort). The [skill](skills/bump-it/SKILL.md) defines the boundary.
- Verification fences off policy changes first, requires exact planned lockfiles and dependency fields, exact planned
  Gradle declarations, unchanged unplanned declarations and floors, correct action pins and all generated wrapper bytes/modes plus official checksums. Only after every local
  check passes does it run `compare`, which must also pass. A report of local problems means `compare` has not run.
- Open PRs count only when the head matches their body state or the exact tool journal entry. Same plan: leave it to
  review. Changed plan: merge base, revert all old PR edits to base, apply the new plan, verify and push a normal commit.
  A human push is left alone; a separate PR is opened. Other tools' overlapping PRs never suppress work.
- `maxNewMajorsPerRun` (default 3) caps only new major PRs. Updates are uncapped. Deferred packages are saved under
  `<state>/deferred/` and get priority next run. Reports include every failed/deferred unit and unresolved copy.
- A major whose direct-peer set cannot coexist within the companions' compatible lines is reported as `blocked`
  with its reason. bump-it does not coordinate multiple major migrations into one PR.

Plans carry moves and npm file hashes, with a bounded copy-change summary, never file contents. Major manifests also
carry a hash of their dependency fields, allowing later review to protect them while retaining script adaptations.
For a planned wrapper move the tool runs `./gradlew wrapper --gradle-version X
--gradle-distribution-sha256-sum SUM --distribution-type bin|all --no-daemon` twice, sequentially, under
`runSandboxed` in an exported base commit. This replaces design item 31's agent-run generation. The first call
selects the target; the second regenerates its jar and scripts. The tool preserves bin/all, rejects other changes
to tracked or non-ignored repository files, and copies all four generated files into the working copy before any
agent work. Ignored build/cache output stays in the scratch copy. The plan records each file's SHA-256 and executable
mode; verification requires those exact bytes and modes, plus the official distribution URL/checksum and jar checksum.
The agent never edits wrapper files. A routine with only npm and wrapper moves needs no agent.
Selection or generation failures leave the wrapper out with a reason in the run report and plan notes; other moves
continue. Verification of a planned wrapper still fails closed. A wrapper major whose recomputation is unavailable
keeps its existing PR for a later review. Only the root wrapper is supported; mirrors, custom distribution URLs and
prerelease base wrappers are reported as unsupported rather than guessed.

## Review

The [shared tick](../remediation) leaves human pushes alone, recomputes on any base movement before reading CI, then
handles pending/green checks without a model. A routine recomputes the whole routine; a major recomputes its package.
Nothing remains: close. Changed routine plan or major target: reconcile by revert. Otherwise merge, resolve dependency
conflicts from base (wrapper jars restored as binary) and re-apply (major code conflicts go to the agent's `resolve` mode), verify, publish normally.
If recomputation blocks a major's direct-peer set, the tick reports an `error` with the reason and retains the PR
and branch for a later tick; it does not treat the blocked move as completed work.
Clean same-target major merges preserve existing script/config adaptations. Failed major CI gets at most two
high-effort adaptations, with the attempt counted before the agent starts. Routine CI failures are reported without
an agent; after the shared two-attempt budget the PR closes. One PR's problem does not stop the tick.

R7's daily main scan and open-PR rescan remain CI's responsibility; this tick reads those checks, it does not replace them.

## Setup and isolation

Use `~/.config/leanish/bump-it/agent.yaml`, with explicit repository opt-in and the shared
[configuration](../remediation). Requires Node 24, git, gh and authenticated Codex. **npm 11.17.0 or later is required
whenever the final age-exclusion list is non-empty**: own npm scopes or young/unreadable locked base versions need
`min-release-age-exclude`. With older npm, the run reports the affected unit as failed with the reason, excluded names,
and required and detected versions, before editing npm files or publishing. Without exclusions,
use npm with min-release-age support. No npm installation or registry requests are needed for the unit tests.

Two separate Keychain tokens, default services `leanish-bump-it-write` and `leanish-bump-it-read`: the tool alone
receives the write token; the agent receives only the read token. Optional `secrets` overrides may share a pair with
secure-it; every opted-in repo uses this pair, and write/read values must differ. PAT mode remains an alternative
when GitHub App mode lands. npm, Gradle inventories and agent checks run under the agent's sandbox,
with protected home paths and git metadata, and
writes restricted to the working copy, temp and build cache. The pinned OSV-Scanner stays in protected tool state,
verified immediately before running. See [the security model](../../docs/security-model.md).

See [Adopting the tools](../../docs/adopting-tools.md) for the read-only candidate preview, first live run,
Keychain permissions, and four complete launchd examples (weekly bump-it run, review every four hours).
The [config reference](../../docs/tool-configuration.md) covers every agent.yaml field. Nothing merges itself.

Deprecated npm releases are excluded from direct and transitive target candidates, including accidental majors. A deprecated version already in the base can stay when no eligible replacement exists; it is never selected as a new target.
