---
name: secure-it
description: Apply selected Gradle and action security moves, adapting code only for a major, and write the PR text. The tool writes and protects npm files, verifies with the gate, and publishes.
compatibleCodingAgents:
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [repo, mode, moves, floorsFile, today, npmAgeExclusions]
  properties:
    repo:
      type: string
    mode:
      type: string
      enum: [apply, adapt, resolve]
    today:
      type: string
    moves:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [ecosystem, name, from, to, mechanism, locations, advisories, major]
        properties:
          ecosystem:
            type: string
            enum: [npm, Maven, GitHub Actions]
          name:
            type: string
          from:
            type: string
          to:
            type: string
          mechanism:
            type: string
            enum: [npm-direct, npm-lock, npm-override, gradle-declared, gradle-floor, action-pin]
          locations:
            type: array
            items:
              type: string
          advisories:
            type: array
            items:
              type: string
          major:
            type: boolean
          commitSha:
            type: string
          declaredAs:
            type: string
    floorRemovals:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [ecosystem, package, version, declaredIn, locations, advisories]
        properties:
          ecosystem: { type: string, enum: [Maven] }
          package: { type: string }
          version: { type: string }
          declaredIn: { type: string }
          locations: { type: array, items: { type: string } }
          advisories: { type: array, items: { type: string } }
    toolWritten:
      type: array
      items: { type: string }
    npmAgeExclusions:
      type: array
      items:
        type: string
    floorsFile:
      type: string
    failingChecks:
      type: array
      items:
        type: string
    conflicted:
      type: array
      items:
        type: string
outputSchema:
  type: object
  if:
    properties:
      outcome: { const: applied }
  then:
    required: [publication]
    properties:
      publication: { type: object }
  additionalProperties: false
  required: [outcome, summary]
  properties:
    outcome:
      type: string
      enum: [applied, cannot-apply]
    summary:
      type: string
      minLength: 1
      maxLength: 2000
    publication:
      type: [object, "null"]
      additionalProperties: false
      required: [title, body, commitMessage]
      properties:
        title:
          type: string
          minLength: 1
          maxLength: 200
        body:
          type: string
          minLength: 1
          maxLength: 20000
        commitMessage:
          type: string
          minLength: 1
          maxLength: 200
---

# secure-it

You apply the security moves or explicit floor removals supplied for the working copy of `repo`. **secure-it already chose the explicit targets
and mechanisms.** Your job is the non-npm edit, major adaptation and PR text. The tool has already resolved npm and written its
exact files. That graph may include induced transitives absent from the explicit moves; preserve them. The tool verifies the whole result
with the supply-chain gate before publishing it.

Apply every explicit move together. A routine plan batches non-major fixes across packages and ecosystems; a major
plan keeps that package's failing copies together; malware is one indivisible plan. Never silently omit a move or
publish only the easiest ones. If you cannot apply the supplied plan, answer `cannot-apply`. The tool owns the one
verification retry that may remove named package groups, and records those omissions in the report and PR body.
The moves may include direct peer companions with no advisory targets (for example vitest's UI and coverage
packages). Code chose their exact versions to make the set consistent; apply them too. Never choose or add further
direct companions yourself. Report an unhandled peer conflict as `cannot-apply`; the tool does not parse your prose
to invent version choices.

## Removing redundant floors

When `floorRemovals` is supplied, there are no version moves. The tool already proved this exact set jointly,
without dependency locks, and wrote the floor records and any npm manifests/lockfiles. Leave every `toolWritten`
file byte for byte; never run npm install/update or change those files. In the listed Gradle declaration files,
remove only the explicit dependency at the exact floor version whose `because(...)` names every supplied advisory,
from every listed configuration. Preserve all other declarations (including compatibility floors), locks, build
logic and repository code. If the declaration is shared with an unplanned floor, cannot be removed precisely, or
requires other edits, answer `cannot-apply`. Run relevant checks with `--no-daemon` for Gradle. Do not add or raise
floors, change parents, or adapt code in a removal plan. The tool writes this PR's text itself.

## Tool-written npm files

The tool applies every npm target and direct companion simultaneously with temporary exact declarations, installs
under the release-age window and supplied exclusions, restores the intended ranges and formatting, then installs
again and checks every exact target. Peer-resolved copies use temporary exact root/workspace declarations, since
npm may ignore overrides for peers. Unsupported placements stop that unit with a reason. Persistent security
`npm-override` floors are written by the tool too. Induced transitive versions are npm's choice, judged by `compare`.

Never edit npm dependency fields or lockfiles, or add a companion yourself. Leave `toolWritten` files byte for byte;
a major may adapt only a package.json's other fields (for example scripts), preserving dependencies, devDependencies,
optionalDependencies, peerDependencies, bundleDependencies/bundledDependencies, peerDependenciesMeta, overrides
and workspaces. If installation is needed for checks use `npm ci --ignore-scripts`, passing every supplied
`npmAgeExclusions` as repeated `--min-release-age-exclude=<entry>` flags. Never run npm install/update or anything
that rewrites a lockfile. Never lower/unset the window or add exclusions of your own.

## What you may change

- Only the non-npm moves: Gradle declarations, build and settings files, `gradle/libs.versions.toml`,
  and `floorsFile` (`.github/dependency-floors.json`).
- Code, tests and docs **only when a move has `major: true`**, and only to adapt to that major.
- Direct dependencies outside the supplied moves keep their declarations and locked versions. Never edit another
  dependency's version by hand or add an unplanned override or floor.
- Preserve existing floor records and declarations, except the exact `floorRemovals` described above. Never alter a compatibility floor. A Gradle security floor may move
  only to the supplied exact target at its planned locations, keeping its file, selectors, reason, added date and
  existing advisory IDs; add only the supplied target IDs. Only planned `gradle-floor` additions are yours to write; npm floors are tool-written.
- The tool-written npm graph can include induced transitives absent from `moves`. Preserve them exactly; do not
  reject or revert them merely because another open PR chose a different version. `compare` judges all changes.
- Never change `.github/supply-chain.json`, `.github/supply-chain-exceptions.json`, or a workflow or action file,
  except the `uses:` lines an `action-pin` move names in its `locations`. The tool rejects any other change to them,
  whatever the move.
- Never commit, push, create branches or touch git: the tool does that. Leave nothing else in the working tree (temporary
  files included): everything left there is committed.

## Each mechanism

- `npm-direct`, `npm-lock`, `npm-override`: already applied by the tool. Preserve its exact lockfiles, dependency
  fields and any floor records. Never re-resolve, install a different target, or hand-edit a transitive.
- `gradle-declared`: a dependency the build declares. Change its version where it's declared (the version catalog if
  it comes from there, else the build file).
- `gradle-floor`: a transitive dependency. In each configuration of `locations` (`:runtimeClasspath`,
  `buildSrc/:compileClasspath`, …), declare it explicitly at exactly `<to>`, with `because("<advisories, comma-separated>:
  <one line on why>")`, in the configuration the resolving one extends (e.g. `implementation` for `runtimeClasspath`,
  `testImplementation` for `testRuntimeClasspath`); use the catalog when the build uses one. Then add its floor entry to
  `floorsFile` with `"ecosystem": "Maven"`, `"selector"` the same configuration locations, `"declaredIn"` the file you
  edited.
- `action-pin`: replace each `uses:` of the action in `locations` with `<name>@<commitSha> # <to>`.

Read the repository's `AGENTS.md` (or `CONTRIBUTING.md`) first if it has one, and follow its conventions for build
files and commit messages.

## `mode: resolve`

The default branch moved and merging it into this PR's branch conflicted in `conflicted` (code files; secure-it already
took the default branch's side of the dependency files). Resolve each file so it keeps both the default branch's
changes and what this PR's moves need (a major's adaptation), with no conflict markers left; then apply the moves as in
`apply`. Same limits as above.

## `mode: adapt`

The change was published and CI failed (`failingChecks` names the jobs and status contexts). Find out why with
`gh run list --commit <head SHA>` and `gh run view --log-failed` (Actions read), or read the failing commit status
contexts (Commit statuses read). The Checks API is not needed; your token reads only. Fix what the move broke,
within what you may change. If the failure isn't caused by the move, or fixing it needs more than that, answer
`cannot-apply` and say why.

## Your answer

End with one fenced `json` block, nothing after it:

- `applied`, with `publication`: a title like `moving snappy-java to 1.1.10.10 for 7 advisories` (lower case, what
  changes); a body that says why (the advisories, in a sentence or two) and, for a major, what you adapted (secure-it
  adds the table of moves itself). Also mention required transitive changes npm made and why; their versions are
  npm's resolution, not explicit rule-picked targets. The tool verifies them before publishing. Use a commit message
  in the repository's style.
- `cannot-apply`, with a `summary` of what stopped you. Omit `publication` or set it to `null`.
