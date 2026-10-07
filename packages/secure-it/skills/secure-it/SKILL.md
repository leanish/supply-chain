---
name: secure-it
description: Apply the security fix secure-it already chose (packages, versions, mechanisms) to the working copy, adapting code only for a major move, and write the PR's title, description and commit message. The tool decides versions, verifies the result with the supply-chain gate, and publishes.
compatibleCodingAgents:
  - codex
inputSchema:
  type: object
  additionalProperties: false
  required: [repo, mode, moves, floorsFile, today]
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

You apply one security fix to the working copy of `repo`. **secure-it already decided everything that's a decision:**
which packages, which versions, and how each version is changed (`mechanism`). Your job is the edit, done the way this
repository does things, and the text of the PR. After you finish, the tool verifies the result with the supply-chain
gate and publishes it; anything outside the plan makes it refuse.

## What you may change

- Only what the moves need: dependency declarations, lockfiles, Gradle build and settings files, `gradle/libs.versions.toml`,
  and `floorsFile` (`.github/dependency-floors.json`).
- Code, tests and docs **only when a move has `major: true`**, and only to adapt to that major.
- Never another dependency's version, an exception file, a workflow, CI or the gate's configuration.
- Never commit, push, create branches or touch git: the tool does that. Leave nothing else in the working tree (temporary
  files included): everything left there is committed.

## Each mechanism

- `npm-direct`: the package is a direct dependency (`locations` names `lockfile#workspace`). Change its range in that
  workspace's `package.json` to `^<to>` (keep the existing range style: `~` stays `~`, an exact version stays exact),
  then `npm install <name>@<range> --package-lock-only --ignore-scripts` in that workspace.
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

The change was published and CI failed (`failingChecks` names the checks). Find out why with `gh pr checks` or `gh run
view --log-failed` (your token reads only). Fix what the move broke, within what you may change. If the failure isn't
caused by the move, or fixing it needs more than that, answer `cannot-apply` and say why.

## Your answer

End with one fenced `json` block, nothing after it:

- `applied`, with `publication`: a title like `moving snappy-java to 1.1.10.10 for 7 advisories` (lower case, what
  changes); a body that says why (the advisories, in a sentence or two) and, for a major, what you adapted (secure-it
  adds the table of moves itself); a commit message in the repository's style.
- `cannot-apply`, with a `summary` of what stopped you. No `publication`.
