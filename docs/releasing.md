# Releasing supply-chain

All workspace packages remain private. Consumers use a reviewed Git commit;
there is no npm publication. The root version identifies the release.

The release flow follows java-conventions: prepare a dated CHANGELOG entry in a
small release PR, merge it, tag its exact merge commit, and create the matching
GitHub release. A release candidate is run for real and reviewed first, so the
release ships what was reviewed. The first release was v0.1.0; each release
lists its changes in [the CHANGELOG](../CHANGELOG.md).

1. Start from the latest reviewed main. Keep PAT mode documented; GitHub App mode
   remains deferred and will be an alternative to PAT mode when implemented.
2. Tag the candidate commit on main with a lightweight `v<version>-rc.<n>` tag
   (candidate tags never move either). Before any release PR:
   - run the tools for real from a checkout of the candidate, as the
     [adoption guide](adopting-tools.md) describes, on adopting repositories
     where the release's changes apply;
   - have whoever didn't implement the release's changes review the candidate's
     whole state, unprimed: say what to review, not where to look. Real runs only
     reach the cases the adopting repositories have today; this review looks for
     the ones they didn't exercise.

   A fix found here lands on main through its own PR and gets a new candidate,
   `rc.<n+1>`, which is run and reviewed again. Release only a candidate with
   no unresolved review findings. A finding whose only effect is that a tool
   doesn't update something automatically (it skips it with a note, or the
   attempt fails visibly) doesn't block: it's documented as a known limitation
   and fixed in a later version. Findings that weaken verification or the gate,
   produce wrong data, or abort whole runs always block.
3. Open `release/<version>` from the reviewed candidate's commit; if main moved
   past it, those commits need a candidate of their own first. Set the root
   version in `package.json` and both root version fields in `package-lock.json`;
   finalize the CHANGELOG heading with the release date. Keep every
   `private: true` and workspace version intact.
4. Run `npm run check` and require green CI and CodeQL on the release PR's head.
   CI exercises the real Gradle inventory acceptance tests. Report integration
   skips, and retain the [real-run evidence](validation.md).
5. Right before merging, check against the candidate: main must still be at the
   candidate's commit (the squash lands on main, not on the PR's head), and
   `git diff v<version>-rc.<n> HEAD` on the release PR may show only the release
   metadata of step 3 and the docs' current-release pointers. Anything else,
   including commits main gained meanwhile, needs a new candidate, run and
   reviewed.
   Squash-merge the release PR and create a lightweight `v<version>` tag at
   **its exact merge commit**. Create the matching GitHub release with the fixes
   and a link to `CHANGELOG.md` for more information, as java-conventions does.
   Do not move an existing tag or publish packages.
6. When the reusable workflow or gate code changes, resolve the tag's full commit
   SHA and repin adopting workflows to
   `leanish/supply-chain/.github/workflows/supply-chain.yml@<full-sha> # v<version>`.
   Require green adoption PR checks before merging. Tool-only releases do not
   require gate repins.
7. Install tools from that release commit in a stable checkout outside `/tmp`.
   Use the [adoption guide](adopting-tools.md) and preserve the owner's configs
   and secret-service overrides when switching the scheduled runner. Do not put
   credentials in Git, release notes or scheduling files.

These steps release supply-chain only; consumer repository releases are separate
decisions. Subsequent development must not move a released tag or an adopter's pin.
