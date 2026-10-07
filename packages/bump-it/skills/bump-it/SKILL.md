---
name: bump-it
description: Apply bump-it's selected Gradle declarations, wrappers and action pins, adapting code only for a major. npm files are written by the tool and must remain unchanged.
compatibleCodingAgents: [codex]
inputSchema:
  type: object
  additionalProperties: false
  required: [repo, mode, today, kind, moves, toolWritten]
  properties:
    repo: { type: string }
    mode: { type: string, enum: [apply, adapt, resolve] }
    today: { type: string }
    kind: { type: string, enum: [routine, major] }
    moves:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [ecosystem, name, from, to, mechanism, locations, major]
        properties:
          ecosystem: { type: string, enum: [npm, Maven, GitHub Actions, Gradle Wrapper] }
          name: { type: string }
          from: { type: string }
          to: { type: string }
          mechanism: { type: string, enum: [npm-range, gradle-declared, action-pin, gradle-wrapper] }
          locations: { type: array, items: { type: string } }
          major: { type: boolean }
          commitSha: { type: string }
          wrapper:
            type: object
            additionalProperties: false
            required: [distributionUrl, distributionSha256, jarSha256]
            properties:
              distributionUrl: { type: string }
              distributionSha256: { type: string, minLength: 64, maxLength: 64 }
              jarSha256: { type: string, minLength: 64, maxLength: 64 }
    toolWritten: { type: array, items: { type: string } }
    failingChecks: { type: array, items: { type: string } }
    conflicted: { type: array, items: { type: string } }
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

# bump-it

The tool already chose the versions and computed npm files. Read this repository's AGENTS.md or CONTRIBUTING.md,
then apply only the moves supplied. The tool verifies the edit and publishes; you never commit, push, create branches
or touch git metadata. Leave no temporary files: everything in the working tree is committed.

## Apply

- `npm-range`: already applied by the tool. Never change npm dependency fields, package versions, ranges or lockfiles.
  Keep every `toolWritten` lockfile byte for byte. Keep manifests' dependency fields unchanged (dependencies,
  devDependencies, optionalDependencies, peerDependencies, bundleDependencies/bundledDependencies,
  peerDependenciesMeta, overrides, workspaces). Only a major may adapt a manifest's other fields (scripts, config).
- `gradle-declared`: edit the declarations in every configuration location, to exactly `to`, keeping the repository's
  version catalog and build conventions. Never add or change transitive constraints or raise a floor.
- `gradle-wrapper`: the tool chose `to` and supplied official checksums in `wrapper`. Run
  `./gradlew wrapper --no-daemon --gradle-version <to> --distribution-type <bin-or-all> --gradle-distribution-sha256-sum <wrapper.distributionSha256>`
  twice, sequentially, from the repository root, inside your sandbox. Take bin/all from `wrapper.distributionUrl`.
  The first invocation selects the new distribution; the second generates its wrapper jar and scripts. Both must
  succeed. Do not download a jar yourself or substitute a distribution/checksum. Keep the properties file's other
  settings. Wrapper files may change only when this mechanism is supplied; code adaptation requires a major.
- `action-pin`: replace the planned action's uses in the named files with its same owner/repo/path at `commitSha # to`.
  Preserve the action's path. When a file has several versions, move only the uses at `from` to that move's target.
- Never edit a dependency version outside the supplied moves. The tool-written npm graph can already include
  refreshed or induced transitive versions absent from `moves`; preserve them exactly as written, even if another
  open PR picked different versions. Do not revert them for being outside the move list or resolve them yourself.
- Never change .github/dependency-floors.json, supply-chain.json, supply-chain-exceptions.json, or workflows/actions
  beyond the supplied pins.
- Code, tests, docs and manifest scripts/config may change only for `kind: major`, to adapt to that major.

## Verify

Run the repository's relevant checks. npm commands inherit min-release-age and min-release-age-exclude from the
runner. Use `npm ci --ignore-scripts` when installation is needed: do not write lockfiles at all. Do not run npm
install, npm update or any command that rewrites the tool's npm files; --package-lock-only is not a check. Don't run
Gradle's wrapper task unless a `gradle-wrapper` move is supplied; then run the exact two invocations above.

## Resolve and adapt

In `resolve`, resolve the named code conflicts, preserving the base's changes and this major's adaptation; leave no
conflict markers. The tool has taken the base's side of mechanical dependency files and re-written its npm plan.
Then apply the non-npm moves. In `adapt`, investigate `failingChecks` (Actions job names and commit status contexts)
with `gh run list --commit <head SHA>`, `gh run view --log-failed` or commit status reads. These use Actions and
Commit statuses permissions, never the Checks API. Fix only what this major broke. If it cannot be fixed within these limits, answer cannot-apply. Routine failures are not adapted.

## Answer

End with one fenced json block and nothing after it. For applied, include summary and publication (title, body,
commitMessage): lower-case, concrete text about the update and any adaptation. The tool adds its table and plan block.
For cannot-apply, give summary only. Never claim a check passed unless you ran it successfully.
