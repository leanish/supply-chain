# Supply-chain: requirements and behavior

**Scope: current main, as of 2026-10-10.** Coverage depends on each adopter's configuration. This document describes the implemented contract, including its limits.

## 1. What it is and what it solves

Three components share one dependency policy: the **CI gate** blocks security regressions in what a repository installs; **secure-it** proposes minimal direct and transitive security fixes and removes proven redundant security floors; **bump-it** proposes routine updates and separate major migrations. Both tools run locally: code selects versions and verifies edits, while a coding agent applies flexible edits and adapts major migrations. The operating routine is daily scanning/remediation, weekly updates and review ticks every few hours. The tools open and update PRs and can mark them ready; people decide merges.

**Terms.** *Base* is the comparison reference; *head* is the proposal. A *finding* is ecosystem + package + advisory alias group (a CVE and its GHSA count together), irrespective of version, location or copy count. A *floor* is a recorded minimum with a reason. A *compatible line* follows npm's caret range or Maven's first numeric segment, adjustable through `compatibleLines`; a major move crosses that line. Security selection preserves Maven flavors such as `-jre` and admits prereleases only when the base version is one. *Release age* starts at publication; an *aged* version has reached the configured wait.

## 2. Requirements

| ID | Current rule | Reason |
|---|---|---|
| R1 | Fix vulnerabilities at any inventoried depth in npm and Gradle. bump-it does not select Gradle transitive bumps; parent/plugin updates may induce them. | The vulnerable package is often transitive. |
| R2 | PRs block new findings and warn on inherited ones. Malware always blocks. Full scans fail every finding without a valid exception. | Allow partial improvements without hiding existing debt. |
| R3 | Security: first fixing line, lowest aged fix, otherwise lowest young fix. Routine: highest eligible aged version. Own packages skip only the wait. | Separate urgent repair from freshness. |
| R4 | Code selects and verifies, writes npm files and generates wrappers. The agent edits Gradle/Actions and adapts code for majors. | A model's answer does not prove its edit. |
| R5 | Floors are recorded and effective. secure-it manages security floors and proves joint unlocked removal; compatibility floors stay. bump-it preserves all floors. | Keep restrictions justified and safely removable. |
| R6 | Use OSV-Scanner and source-repository advisories; Actions also uses GitHub's advisory database. Report gaps. | Cover database ingestion delays. |
| R7 | CI scans default-branch pushes and daily; daily rescans judge open PRs and their cooldown against current bases. | Detect vulnerabilities and policy changes without a new PR commit. |
| R8 | Each comparison shares one advisory snapshot over **base ∪ head ∪ required candidates**. Each selection decision shares data for current and candidate versions. | Avoid regressions invented by mismatched queries. |
| R9 | Configurable wait, seven days by default. A proven young fix can pass the gate but remains held by cooldown, even with an exception. | Urgency does not establish release trust. |
| R10 | Age/own-package policy is the stricter of base and head. Tools preserve configuration, exceptions and workflows except planned action pins. | A proposal cannot authorize its own bypass. |
| R11 | Check npm publisher/provenance continuity for replaced versions; CI audits signatures and attestations. | Check identity as well as version. |
| R12 | Inventory all covered resolvable external Gradle modules, including tests/tools/processors, buildscript/settings classpaths and nested builds. Incomplete inventories fail. | Build dependencies execute code too. |
| R13 | Every new/changed remote action occurrence requires a full SHA and a verified full-tag comment; subdirectories, duplicate steps and YAML aliases count. | Identify each added executable use. |
| R14 | npm preserves exact targets, unplanned directs and existing constraints; direct peers are solved jointly. | Prevent silent resolver changes. |
| R15 | Never select new deprecated npm targets; Node types cannot exceed the lowest provable supported runtime. | Avoid withdrawn versions and unsupported APIs. |
| R16 | Group routine moves; separate majors. secure-it separates coupled young fixes and prioritizes malware. bump-it caps new majors and prioritizes deferred ones. | Keep PRs reviewable without delaying patches. |
| R17 | Independent repository opt-ins, configurations and PR ownership per tool. Overlapping PRs from another producer do not suppress work. | Explicit scope and independent remediation. |
| R18 | Recompute when base moves, preserve human pushes, guard publication races and recover plans. No automatic merges or force-pushes. | Avoid overwriting human work. |
| R19 | Separate build execution, verdict and publishing credentials; the agent receives only a read token. | Limit compromise impact. |
| R20 | Missing required data, proof or verification fails closed. Allowed omissions are reported. | Unverified is not safe. |
| R21 | Consume reviewed commits, pin workflow/scanner, and release through real-run rc validation and an independent unprimed review. | Ship what was reviewed. |

Contracts: [gate](../packages/ci/README.md), [secure-it](../packages/secure-it/README.md), [bump-it](../packages/bump-it/README.md), [configuration](tool-configuration.md).

## 3. Behavior by scenario

### 3.1. Findings and remediation

| Scenario | Component behavior | Reason |
|---|---|---|
| Vulnerability in a direct npm dependency | **Gate:** a new finding blocks; shared findings warn on PRs and fail full scans. **secure-it:** minimal fix, manifest range and lockfile. **bump-it:** may fix through routine selection, without promising a minimal move. | Gate judges regression; remediation also addresses base debt. |
| Vulnerability in a transitive npm dependency at any recorded depth | **secure-it:** exact locked-copy update if every parent permits; otherwise persistent override plus floor. Code materializes the graph; **gate** checks induced versions, source, identity, age and floors. | Do not wait for a new parent release. |
| Vulnerability in a direct Gradle dependency the repository's sources declare | **secure-it:** exact declaration in affected configurations, resolution at or above target, and no remaining target advisories. **Gate:** judges resolved versions. | Conflict resolution may choose above the declaration. |
| Vulnerability in a transitive Gradle dependency, or one only a plugin declares | **secure-it:** explicit dependency in the affected configuration (next to the plugin's own declaration, which stays), `because(...)` and recorded floor. A plugin's `strictly(...)` version or multi-artifact `defaultDependencies` make that attempt fail visibly. **bump-it:** no explicit routine transitive bump. **Gate:** declaration and resolution checks. These floors are not `constraints` blocks. | Enforce the fix where the dependency is consumed. |
| Fix removes A while B still affects the package | **Gate:** A fixed/B inherited passes if other checks pass. **secure-it:** must remove promised advisories from every remaining copy of the planned package; unfixable advisories remain reported. | Improve security without claiming all debt disappeared. |
| Advisory appears on a version shared by base and head | **Gate:** one snapshot makes it inherited on the PR, failing on main. **secure-it:** considers it without requiring recent dependency edits. | Publication time does not make the PR responsible. |
| Same advisory affects a different package added by the PR | **Gate:** blocks because the finding's package differs. An extra copy of the same package with that advisory remains inherited. | The rule measures finding identity, not exposure, severity changes or copy counts. |
| Source repository publishes an advisory OSV does not yet cover | **Gate:** uses the repository range; once OSV has the advisory for that package, OSV's version verdict takes precedence. Repository malware is always retained. **secure-it:** can select a fix from this detection. | Cover ingestion delays without conflicting normalization. |
| New, inherited or bundled malware | **Gate:** always fails, without exceptions (`MAL-*` IDs/aliases or GitHub CWE-506). **secure-it:** indivisible priority unit; nearest clean aged version, first higher in-line, then lower, then a higher line. Own packages skip age. A blocked malware repair prevents other plans. **bump-it:** cannot publish with malware remaining. | Existing debt does not excuse malware. Detection depends on advisory sources, not package-content analysis. |
| No fix, or a blocked copy of a package | **secure-it:** reports and excludes unverifiable package groups while other units proceed. Fixable advisories can be addressed with `unfixable` ones left inherited. Malware prevents unrelated units. | Do not claim a package repaired while targeted copies remain vulnerable. |

### 3.2. Versions, release age and cooldown

Age evidence: npm registry publication time; Maven POM `Last-Modified` from the first configured repository carrying it (defaults: Central/Plugin Portal); GitHub release publication, not tag date, for Actions; official `buildTime` for wrappers. Insufficient metadata cannot establish age.

| Scenario | Component behavior | Reason |
|---|---|---|
| Base 1.9.4, young backport 1.9.5, aged 2.0.0 | **secure-it:** 1.9.5 if it is the lowest fix in the first eligible line. **Gate:** proves selection to accept its age; **cooldown:** remains red. | Compatible line takes priority over another line's age. |
| Several aged fixes in the chosen line | **secure-it:** lowest fixing target without new findings/malware; no aged fix means lowest young fix. **bump-it:** highest eligible aged target. Gate proves minimal selection for young-fix eligibility, not for every manual aged fix. | The producers have distinct objectives. |
| Young version without a fix for an advisory affecting a replaced version | **Gate:** age failure unless own or valid exception. Labels, PR notes and agent choices cannot prove eligibility. **bump-it:** does not select it and rejects any induced hold. | Routine updates cannot manufacture urgency. |
| npm fix requires a dependency/peer with no aged satisfying version | Registry requirements, base constraints and real placements prove the lowest stable non-deprecated target. Another independently verified security fix takes precedence when its target satisfies all ranges. Gate reconstructs recursive requirements/joint peers; ordinary upgrades stay at base in the proof, base overrides constrain it, absent optional dependencies are not introduced. Young choices stay held. | The exception comes from requirements, not PR-narrowed ranges or hidden plans. |
| Lowest required version is unsafe, metadata is missing, or search exhausts | Block proof/unit; do not substitute an arbitrary higher young target. Bounds: depth 8, 128 nodes/root, 2,048 versions/requirement; peers: 128 companions, 2,048 candidates each, 4,096 assignments/search. | Bounds grant no partial exemption. This proof applies only to npm. |
| Legitimate young fix or `releaseAge` exception | **Gate:** may pass; **cooldown:** holds young changed versions, own packages aside. **secure-it:** separate `security-cooldown` routine for young/coupled fixes; majors/malware stay whole. Draft warning includes dates, rationale and npm provenance/publisher/new-script signals. | A valid version choice does not establish trust. |
| Taking a held release early | Human decision: every other check green, reason written on the PR, admin merge past red cooldown. Without an enforcing ruleset, still document the reason. secure-it neither marks it ready nor merges it. | Urgency does not remove publication risk. |
| Held versions age out | **secure-it:** closes its held draft as `graduated`; next run plans from base with fresh checks. A held PR a person marked ready is left alone. Daily rescan recalculates cooldown, but a success status cannot clear a red job: a human PR needs the **whole workflow** rerun on its current revision; rerunning cooldown alone reads the old report. | Both required job and status must pass. |
| Base increases its wait after a PR went green | **Daily rescan:** recomputes under current base/head policy and publishes a new cooldown status; versions now under the wait are held again. **Review ticks:** recognize a cooldown-only hold as waiting, not an adaptation failure. | An old green check cannot preserve a weaker policy. |
| PR lowers age or declares the package own | **Gate:** maximum base/head wait; own only on both sides. Unreadable base policy leaves cooldown unevaluated and red. Change policy separately first. | The PR cannot relax its own age policy; other human policy edits still require review. |
| Own package | Configured npm scopes, exact Maven groups, plugin ID prefixes limited to markers, and Actions owners skip age only. Their dependencies keep the wait; advisories, malware, source, identity and pins still apply. | Ownership is an age exemption, not universal trust. |
| A lower fix ages between planning and CI | If the young proposal is no longer the rule-picked fix, **gate fails** and secure-it must recompute. | Verification uses the safer candidate now available. |

### 3.3. Routine updates, peers and Gradle

| Scenario | Component behavior | Reason |
|---|---|---|
| Week without vulnerabilities | **bump-it:** routine PR with direct minor/patch moves, npm transitive refresh, Actions and eligible wrapper. Docker CLIs require configured npm manifests/locks; arbitrary Docker images are not updated. | Freshness does not need a security trigger. |
| Major moves are available | One PR per primary package with its selected declarations; agent uses `majorEffort` (examples: high; routine medium). **bump-it:** default three new majors/run; existing-PR updates uncapped, deferred majors prioritized later. | Isolate migrations and bound new work. |
| npm target needs different direct peers | Keep primary targets fixed; select lowest safe companions in their own compatible lines. Compatible peers stay at base; a companion may move downward. Solve incoming/outgoing requirements jointly; new/transitive peers remain npm resolution plus compare. Impossible sets block; no multi-major migration is invented. | Code chooses companions, not the agent. |
| npm changes a copy outside explicit moves | **secure-it:** induced transitives face compare. **bump-it:** additionally selects routine transitives within parent ranges/overrides; majors do not do that general refresh. Exact locks and unplanned directs are protected. | Explicit moves and the resulting graph differ. |
| Unjudgeable npm copy, complex override or exact pin | **bump-it:** retains base copy and reports `unresolved`/pin. A new copy without a provable target or failure to retain a required target fails the unit. Deprecated versions are never new targets. | Explicit omission is preferable to a guessed update. |
| `@types/node` would exceed supported Node | **bump-it:** minimum support from engines, version files, Volta and static setup-node, including workspaces/matrices. Without evidence, only current type-major updates; new copies require evidence. Existing overly high types need manual correction. | Newer development/CI Node does not raise declared support. |
| Gradle plugin adds a dependency absent from repository source evidence | **Gate:** scans its resolved configuration. **bump-it:** does not select it as editable and lists it in `notes`. Injected consumer dependencies are covered by consumer CI. | Detection does not establish an editable declaration. |
| Updating a plugin changes dependencies it injects | **bump-it and secure-it:** `plugin-driven` allowance only for a planned plugin on the same build's buildscript/settings classpath, and a remaining diff containing only exact planned version swaps except independently exact-checked files. No extra mode changes or unreadable text. Under that proof the injected declarations may change version, appear or disappear; a secure-it fix that also adds a floor keeps the strict checks. **Gate:** judges every resulting version. | A restricted diff supports attributing the change to the plugin. |
| Plugin is an ordinary buildSrc/build-logic dependency, or major also adapts code | Proof does not cover resulting unplanned declarations; verification fails. Routine edits outside build scripts and `gradle/libs.versions.toml` can also fail. | Known proof/editability limits do not authorize a broader diff. |

Gradle source evidence is textual and repository-wide: coordinates, group/name pairs, plugin IDs and catalogs. **Comments count; names in another build count.** It does not interpret Kotlin/Groovy semantics, and misses shorthands such as `kotlin("stdlib")`, string escapes and external sources. It may skip an update or attempt one that fails visibly. `plugin-driven` swaps are recognized by text; a declaration sharing exact `from`/`to` strings can move with the plugin. See [candidate selection](../packages/ci/README.md#picking-a-fix-candidates) and [the plugin-driven proof](../packages/remediation/src/plugin-driven.ts).

### 3.4. Floors, identity, Actions and wrapper

| Scenario | Component behavior | Reason |
|---|---|---|
| Add or raise a security floor | **secure-it:** exact planned target in `.github/dependency-floors.json`; preserve existing scope/history. **Gate Gradle:** exact declaration, `because` names advisories, resolution ≥ floor using Gradle ordering. **npm:** recorded override and covered copies ≥ floor. | Declaring a restriction does not prove it takes effect. |
| Compatibility floor or still-needed floor | Both tools retain it; bump-it changes neither floor records nor declarations. Selectors cannot overlap. Gradle `because` without a record is a note: plugins can inject it. | Preserve compatibility and recognize injected policy. |
| Potentially redundant security floors | **secure-it:** separate `floor-removal` PR; individual then joint unlocked proof. npm removes selected overrides and both adjacent lock formats; Gradle filters exact declarations and disables locking/configuration cache. Recorded advisories must stay absent from every resolved copy; incomplete data cannot prove removal. | Locks and isolated proofs can hide a joint regression. |
| Joint removal proof fails | Reduce set and resolve again; retain floors with reasons. Already-used Gradle declarations are retained. Final verification protects other floors/directs, requires computed npm bytes and compare without removed advisories. | Do not mix removal with an incidental parent bump. |
| npm publisher changes | **Gate:** blocks dropped provenance, changed repository/workflow, inconsistency with previous source, or, without provenance, publisher with no history up to the replaced release. Statements bind exact package/version/sha512. Reviewed unexpired identity exception can accept a break; **secure-it** reports blockers rather than inventing another fix. | Check identity continuity as well as authenticity. |
| New npm package or another registry | No listed replaced version means no identity baseline. Other allowed registry: age/identity unsupported except own package with reviewed unexpired identity exception. Disallowed registry fails. CI verifies signatures/attestations in clean projects. | Identity has a defined scope; signatures/provenance do not exclude malware. |
| Incomplete npm bundle or executable alternative source | Missing `inBundle` package/dependency entries fail. Signature verifier refuses Git, tarball URL and external file dependencies; validated internal workspace links are allowed. | Keep installed dependencies inside the selected lock's boundary. |
| New/changed remote Action lacks a verified pin | **Gate:** fails incomplete SHA, absent/floating tag comment or mismatched tag. Non-own uses need a published release and age checks. **Tools:** preserve owner/repo/path and workflow outside planned pins. | Mutable refs and false comments do not identify a release. |
| Additional action occurrence, another subdirectory, or YAML alias | Compare counts file + action including subdirectory + ref + comment. A greater count, changed path/ref/comment or new file is a change; an extra unpinned/unverified step fails even if base has an identical one. | Existing unsafe uses do not authorize more copies. |
| Unpinned/unverified Action occurrence truly unchanged | **Gate:** reports gap. `docker://`, local action without descriptor and missing local reusable workflow are also gaps. | Missing coverage is not evidence of safety. |
| Eligible Gradle wrapper | **bump-it:** root stable/non-broken, highest aged release in current major; newer major separate. Official metadata/checksums and gradle/gradle advisories; generate twice in sandboxed base export, preserve bin/all. Protect four files/hashes/modes, distribution URL/checksum and JAR checksum. Agent never edits them. | Verify and protect the generated result. |
| Wrapper metadata/range unavailable or unsupported distribution | Omit selection/generation with a reason and continue other moves. No nested wrappers, mirrors, custom URLs or prerelease bases. Verification failure for an already planned wrapper blocks publication. | Reported omission differs from publishing without proof. |

### 3.5. CI, PRs and failures

| Scenario | Component behavior | Reason |
|---|---|---|
| Default-branch push or daily scan | Full scan fails unexcepted advisories, malware, invalid floors and incomplete inventories. It does not recheck historical identity/age for every version. | Detect current debt without reconstructing all publication history. |
| Long-lived or stacked PR | Rescan merges head onto current base tip; conflicts use head versus merge base. Re-read open/head/base before statuses, never overwrite newer statuses. Completed comparison also publishes current cooldown; npm signatures only after compare passes. **Tools:** recalculate on base movement. | Keep advisories, policy and base current. |
| Fork PR | Initial check uses fork workflow, read-only token and no secrets. Wait for trusted default-branch rescan status or dispatch it; review builds/workflows. | The PR's own workflow is not independent evidence. |
| Routine PR open when security needs repair | Independent tool branches/markers/labels; other producers' overlap does not suppress work. Same plan/recognized head: `already-open`. Changed plan: merge base, revert old edits to base, apply/verify new plan and push normally. | Independence without old-plan residue. |
| Human push, race or body-update failure after push | Leave human-pushed PR alone; necessary work goes separately. Every write re-reads head/state. Journal recovers exact head/base/title/body/attempt count before reuse. | Do not overwrite people or detach a branch from its plan. |
| CI pending, green or held only by cooldown | Review uses no model for waiting/green states; green can mark ready unless held. Recompute on base movement before CI handling, except retiring an aged planned hold. A daily cooldown `failure` means waiting for either tool; cooldown `error` is not a hold. | Separate waiting from broken verification. |
| CI fails | secure-it version fixes and bump-it majors: at most two verified adaptations, counted before invoking the agent. bump-it routine/floor-removal report without agent adaptation; shared budget closes exhausted PRs. One PR does not stop others. | Bound loops and protect proved edits. |
| Scanner/API/registry failure, malformed JSON, unresolved build or incomplete report | **Gate:** 0 pass, 1 fail, 2 incomplete (also failure). **Tools:** no unverified publication. GET/HEAD timeout/reset gets at most two retries; HTTP errors, malformed JSON and writes do not get those retries. | Missing evidence is not a clean scan. |
| secure-it routine verification fails | One retry from original base, omitting identifiable package groups and connected peers; omissions in report/PR/plan. Global or unattributable induced-transitive failure cannot reduce. Major/malware never reduce. | Partial repair must be selected and reported by code. |
| Old npm, unsupported placement or missed target | Exclusions require npm ≥ 11.17.0. Scriptless resolution with simultaneous pins, restored ranges and another install; missing exact landing fails. Own/young/unreadable-base age exclusions are reported without waiving compare. | Resolver flags do not authorize a different target or bump-it hold. |
| Scan/rescan is missing or incomplete | secure-it warns after `staleScanHours` without successful scheduled scan (default 36), still plans. Identified incomplete PR scan posts gate failure, no new cooldown status. An available completed comparison outcome publishes cooldown `success`/`failure`/`error` independently; successful age evaluation cannot excuse a failed gate. API failure before listing PRs leaves last statuses and fails workflow. | No independent watchdog; both required checks must pass. |
| Excluded repository | Outside a tool's `repos`: reject without agent/publication. Independent opt-ins allow either tool alone. Gate depends on installed workflow; no universal blacklist or central adoption inventory. | Do not claim coverage for unconfigured repositories. |

**Never automatic:** merges, force-pushes, compatibility-floor removal/changes, floor raises by bump-it, agent-selected targets, tool relaxation of policy/exceptions, or invented joint major migrations. Verified normal pushes, PR closure and ready marking are part of proposal maintenance.

## 4. Security guarantees and known limits

Workflow is SHA-pinned and scanner version/hash-pinned. OSV-Scanner runs outside the repository with empty configuration. Verdict calculation and publication stay in their deciding job; Gradle inventory jobs have no write credentials. Builds do not inherit tokens; checkout does not retain credentials. Locally, write PAT stays in the tool, read PAT goes to the agent; repository code is sandboxed, Keychain/sensitive paths/git metadata protected, and tool-run Gradle uses `--no-daemon`. git/gh guards are additional guard rails, not the security boundary.

Signature verification stages fresh manifests/workspaces/selected lockfiles, without repository `.npmrc`, scripts/modules, token/proxy/config environment, or Git execution; separate caches/homes. It trusts runner Node/npm and is **not an OS sandbox for npm**.

| Guarantee or limit | Actual scope |
|---|---|
| Agent edits | Exact locks; full routine manifests/dependency fields for majors; protected declarations/locations/floors/pins/workflows and wrapper hashes/modes. compare judges results; secure-it demands target-advisory removal. Migration semantics still need tests/review. |
| Snapshot | One per compare. Security has initial scan plus candidate snapshot; bump-it has rounds/peers; final verification is fresh. Not an atomic service transaction or one snapshot for the entire run. |
| Policy | Strict base/head age/ownership and tool policy fence. Human PRs can change other configuration/exceptions; review/branch protection remain necessary. |
| Gaps | No GitHub source, repository 404 or unreadable range: repository coverage missing, OSV remains. Inherited unverifiable Actions/`docker://`: gaps. **A verdict can pass with gaps.** |
| Gradle | Build/plugin can misrepresent inventory; cross-PR artifact tampering is also possible in rescan. Local files/JARs are not scanned. Job isolation protects credentials/verdict, not inventory truth. |
| Selection | Textual/plugin-driven limits in §3.3. Direct bump selection weighs ten newest aged versions per line; rejecting that window does not exhaust older ones. More than 2,000 Actions releases prevents complete young-fix proof. |
| Advisory ranges | Unreadable prose is reported; upper-bound-first AND (`< 2.0.0, >= 1.0.0`) can over-match as all versions. |
| Images/wrapper | No OS packages/images; CLIs only through configured locks. No Gradle distribution-content scan; generated scripts are not independently compared with official ones. |
| Operations | GitHub scheduling may delay/drop runs or disable inactive public repos after 60 days. Sequential rescan, at most 256 PRs. Local tools currently macOS Apple Silicon/Keychain/PAT/Codex; no full dry-run, operational GitHub App mode, Linux or Windows launcher. Review cannot see another app's Checks-only results. It reads observed CI, not GitHub's required-check list. |

References: [security model](security-model.md), [reported gaps](coverage-gaps.md#reported-gaps), [undetectable limits](coverage-gaps.md#limits), [wrapper](coverage-gaps.md#gradle-wrapper-updates), [workflow](../packages/ci/README.md#adopting-the-gate).

## 5. Operation

### Adoption

Adopt the [gate](../packages/ci/README.md#adopting-the-gate) first: reusable workflow pinned to full SHA/verified tag, PR/push/schedule/dispatch triggers and suitable JDK. Configure lockfiles/builds/registries/own packages/age/mappings/floors. Exceptions name exact package/version, reason and expiry (inclusive UTC day): vulnerability advisory plus covered paths; age advisory affects a replaced version, not target. Malware cannot be excepted or justify age.

Defaults detect root npm/Gradle; `gradle.builds: []` explicitly disables Gradle. Unknown fields/missing configured files fail. Require `supply-chain / supply-chain` and `supply-chain / cooldown`; customize **both** `required-check` and `required-cooldown-check` for different job/bridge names. Both the workflow check and latest same-named daily status must pass. Keep dependency graph/Dependabot alerts enabled and its PR producers disabled. Required checks for private repositories depend on GitHub plan.

For [local tools](adopting-tools.md), use a stable checkout outside `/tmp`, scriptless installation, Node 24+, suitable npm, git/gh/authenticated Codex, and required JDK/wrapper. Separate `agent.yaml`: opt-in, commit identity, model/efforts and separate state/cache. Distinct Keychain PATs: tool Contents/PRs/Workflows write and Actions/statuses/Metadata read; agent read only. No Checks permission; tools can share a read/write pair through `secrets`. Network: GitHub/OSV/registries/Gradle; secrets stay outside repo/config/plist.

Preview `candidates --rule security|bump`: read-only, no model/publication; Gradle requires exact-commit inventory artifact. It does not simulate final npm/peers/floors/wrapper. Then run manually, inspect report/diff/CI and enable scheduling. **run/review can publish and have no dry-run.** See [configuration](tool-configuration.md).

### Owner's routine

| Frequency | Action |
|---|---|
| Daily | CI scan/rescan and `secure-it run`; inspect malware, blockers/gaps, scan freshness and holds. |
| Every few hours | Independent `secure-it review` and `bump-it review`; launchd examples use four hours. |
| Weekly | `bump-it run`; review routine/majors/deferred work, tests/compatibility and decide merges. |
| After merge/urgent alert | Run/review as needed; recompute base without force-push. Dispatch can rescan a PR immediately. |

Invocation: `packages/remediation/run.sh <secure-it|bump-it> <run|review> <owner/repo>`. Per-tool/repo lock: concurrent invocation exits 75. Reports distinguish applied/omitted/failed/blocked/deferred work and gaps; cost is an API-equivalent token estimate, not a subscription bill or spending cap.

### Releases

[Procedure](releasing.md): immutable rc on main, real runs and whole-state review by someone who did not implement it, **unprimed**: what to review, without steering where to look. Weakened gate/verification, wrong data or aborted runs block release; visibly omitted automatic updates may be documented limits. No unresolved blocking findings: metadata release PR, `npm run check`, green CI/CodeQL and tightly bounded rc diff. Final tag at exact merge commit; no moving tags/npm publication. Repin when gate/workflow changes and deliberately update local checkout. [Real evidence](validation.md); skipped integration is not passing evidence.

## 6. Comparison with alternatives

**Comparison scope: documentation as of October 2026.** The advantage is satisfying these requirements together for npm/Gradle/Actions, with verifiable proposals and an owner-controlled merge. Cooldown, grouping and transitive updates are not exclusive features. Linked primary sources define the comparison; configuration or extensions may reproduce individual requirements.

| Alternative | Documented capabilities | Supply-chain's advantage for this contract | Where the alternative is stronger |
|---|---|---|---|
| Dependabot version updates | Scheduling/grouping, including multi-ecosystem groups, and `cooldown` with default/major/minor/patch days and include/exclude. October docs specify a three-day default, for version updates rather than security updates. [Options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference). | Eligible targets plus exact npm graph protection, agent-assisted majors, and age gate covering any PR under strict base/head policy. | GitHub-managed operation and more ecosystems without maintaining this local runner/code. |
| Dependabot security updates, including GitHub Actions | Minimum patched version, alert-linked PRs and security grouping per ecosystem. npm transitive fixes can update parents and children together. Updates require dependency presence in manifests/locks; non-npm indirect updates cannot also require a parent update. [Security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates), [npm transitives](https://github.blog/changelog/2022-09-07-dependabot-unlocks-transitive-dependencies-for-npm-projects/). | Explicit Gradle floors with reasons/scope and joint removal proof; source-repository advisories; compatible-line-first repair; young security releases still held. | Simple managed activation and alert/PR integration. Keep its alerts as a complementary source. |
| Renovate / Mend Renovate | Per-version `minimumReleaseAge`, required timestamps by default; grouping/schedules/automerge, npm/Gradle `lockFileMaintenance`. October docs describe `osvVulnerabilityAlerts` as experimental and direct-dependency-only. [Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/), [configuration](https://docs.renovatebot.com/configuration-options/). | Independently proved young-fix eligibility, checked/recorded floors with unlocked removal, finding-based inherited debt and exact verification of agent edits. Lock maintenance alone does not establish those guarantees. | Broader managers, mature update configuration/community and automerge; hosted operation avoids this local runner. Self-hosting still needs maintenance. |
| GitHub dependency-review-action | Dependency-graph diff checks for introduced vulnerabilities, configurable severity/scopes and licenses; not a fix producer. [Action reference](https://github.com/actions/dependency-review-action). | Resolved Gradle tools/buildscript/settings coverage, extra advisory source, per-package alias groups/shared snapshot, age/identity/floor checks. | Simple graph-based integration and license policy, which this gate does not provide. |
| Snyk Open Source | Maven/Gradle scanning with different SCM/CLI coverage and documented configuration scopes. [Gradle integration](https://docs.snyk.io/supported-languages/supported-languages-list/java-and-kotlin/git-repositories-with-maven-and-gradle). | Explicit contract for all covered resolvable configurations, floor lifecycle and verification before agent-produced changes publish. | A broader security service and managed integrations; select the scanning mode appropriate to the build. |
| Mend Remediate / SCA bots | Vulnerability monitoring and fix PRs, with package-manager-specific support and remediation limits. [Remediate](https://docs.mend.io/integrations/latest/mend-remediate-and-renovate). | Locally inspectable version policy, floor history/joint proof and shared gate verification. | Managed remediation integration without owning this implementation. |
| Socket | GitHub app reports package risks including known malware and typosquatting. [Guide](https://docs.socket.dev/docs/socket-for-github). | Deterministic version/remediation policy, Gradle floors and exact-edit/age checks. | Specialized package-risk analysis beyond advisory-only detection; a useful complement. |

[Why this adds value alongside dependency alerts](why.md) covers the same ground from the alerts side.

The sources do not establish a universal comparison of deep Gradle remediation, injected plugin dependencies, paid-plan features or configuration immunity across every product. Those are not asserted here.

### What maintaining this code buys

| Need | Implemented advantage |
|---|---|
| Deep transitive repair | npm lock/override and Gradle explicit floor, not only parent bumps. Native Gradle constraints are another technique; this implementation verifies floors rather than writing `constraints` blocks. |
| Avoid urgent migration | First fixing compatible line, lowest aged fix before young; backport before major. If another line alone fixes it, separate agent-assisted major. |
| Allow partial improvement | A fixed/B inherited passes; malware blocks. Finding identity survives version/location changes. |
| Avoid query-timing regressions | Shared base/head/candidate snapshot per compare; selection/verification scopes are explicit. |
| Prevent self-authorized relaxation | Strict base/head cooldown for all PRs; exceptions/labels cannot clear holds. Tool policy fence applies to majors too. Daily statuses enforce current policy. |
| Cover build execution | Resolvable configurations, buildscript/settings, buildSrc/included builds, with inventory/editability limits exposed. |
| Check publisher identity | npm continuity/provenance and signature audit, reviewed exceptions and explicit missing-baseline limits. |
| Trust agent work less | Targets/locks/dependency fields/pins/floors/wrapper verified; constrained plugin-driven diff proof. `applied` alone is insufficient. |
| Remove redundant protection safely | Joint unlocked proof, security floors only, separate PR; compatibility stays. |

The cost is owning code, parsers, inventory adapters, sandbox, tests, local scheduling and releases. Hosted alternatives reduce infrastructure/code maintenance and often offer broader ecosystems, UI/community or merge automation; they still need configuration and review. Supply-chain never automerges.

Operationally, use one producer per function: secure-it for security, bump-it for freshness, external alerts as complements. Another producer on the same lockfiles needs selection/conflict coordination; using its alerts does not require its update PRs.
