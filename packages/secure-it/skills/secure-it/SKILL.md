---
name: secure-it
description: Apply the routine security batch, major fix or malware plan secure-it already chose (packages, versions, mechanisms) to the working copy, adapting code only for a major move, and write the PR's title, description and commit message. The tool decides versions, verifies the result with the supply-chain gate, and publishes.
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
      type: object
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

You apply the security moves supplied for the working copy of `repo`. **secure-it already chose the explicit targets
and mechanisms.** Your job is the edit, done the way this repository does things, and the text of the PR. npm may
also resolve transitive changes required by those moves, under the limits below. The tool verifies the whole result
with the supply-chain gate before publishing it.

Apply every explicit move together. A routine plan batches non-major fixes across packages and ecosystems; a major
plan keeps that package's failing copies together; malware is one indivisible plan. Never silently omit a move or
publish only the easiest ones. If you cannot apply the supplied plan, answer `cannot-apply`. The tool owns the one
verification retry that may remove named package groups, and records those omissions in the report and PR body.
The moves may include direct peer companions with no advisory targets (for example vitest's UI and coverage
packages). Code chose their exact versions to make the set consistent; apply them too. Never choose or add further
direct companions yourself. Report an unhandled peer conflict as `cannot-apply`; the tool does not parse your prose
to invent version choices.

## npm's release window

The sandbox keeps `npm_config_min_release_age`. A security fix may be younger than that window. The tool supplies
`npmAgeExclusions`: the repository's own scope patterns plus only planned packages with young or unreadable target
publish times. It checks npm >= 11.17.0 before asking you to use these exclusions. For **every npm command**, pass each
entry as `--min-release-age-exclude=<entry>` (repeated flags); this keeps the own-scope patterns too, which CLI flags
would otherwise replace. Never lower or unset the age window, or add exclusions of your own. These flags permit
installing the selected security target; they do not permit choosing another version for an explicit move. Verification requires the
exact planned versions and `compare` passes before publication.

## What you may change

- Only what the moves need: dependency declarations, lockfiles, Gradle build and settings files, `gradle/libs.versions.toml`,
  and `floorsFile` (`.github/dependency-floors.json`).
- Code, tests and docs **only when a move has `major: true`**, and only to adapt to that major.
- Direct dependencies outside the supplied moves keep their declarations and locked versions. Never edit another
  dependency's version by hand or add an unplanned override or floor.
- npm may move transitives required by a planned move when you run its install/override mechanism. Let npm resolve
  them under the supplied release-age window and exclusions; do not edit their lockfile entries by hand, run a
  general refresh, or add age exclusions for them. This is allowed even when another open PR picked a different
  version for that transitive. Do not refuse merely because such a required transitive is absent from `moves`.
  Every explicit move must still land exactly at `to`. The tool runs `compare` on every changed version, including
  induced transitives: advisory, age and identity failures prevent publication.
- Never change `.github/supply-chain.json`, `.github/supply-chain-exceptions.json`, or a workflow or action file,
  except the `uses:` lines an `action-pin` move names in its `locations`. The tool rejects any other change to them,
  whatever the move.
- Never commit, push, create branches or touch git: the tool does that. Leave nothing else in the working tree (temporary
  files included): everything left there is committed.

## Each mechanism

- `npm-direct`: the package is a direct dependency of the workspace whose `node_modules` holds the location. Change
  its range in that workspace's `package.json` so its base is exactly `<to>` (keep the existing style: `^` stays `^`,
  `~` stays `~`, an exact version stays exact; an `npm:` alias, named in `declaredAs`, keeps its key and target:
  `npm:<name>@^<to>`), then run `npm install --package-lock-only --ignore-scripts` next to the lockfile.
- `npm-lock`: a transitive dependency whose parents' ranges all allow `to`; lock exactly `to` (never `npm update`, which
  can go past it): add a temporary `overrides` entry pinning `<name>` to `<to>` in the lockfile's `package.json`, run
  `npm install --package-lock-only --ignore-scripts`, remove that entry, run it again, and check the lockfile still has
  `to` at every location.
- `npm-override`: a transitive dependency no parent range allows to fix. Add an `overrides` entry pinning `<name>` to
  `<to>` exactly (nested under the parent when `locations` shows only one parent), run `npm install --package-lock-only
  --ignore-scripts`, and add a floor entry to `floorsFile`: `{ "ecosystem": "npm", "package", "version": "<to>",
  "declaredIn": "<package.json path>", "selector": [[...override key path]], "purpose": "security", "advisories",
  "reason", "added": "<today>" }`.
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
- `cannot-apply`, with a `summary` of what stopped you. No `publication`.
