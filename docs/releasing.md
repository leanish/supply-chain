# Releasing supply-chain

All workspace packages remain private. Consumers use a reviewed Git commit;
there is no npm publication. The root version identifies the release.

The release flow follows java-conventions: prepare a dated CHANGELOG entry in a
small release PR, merge it, tag its exact merge commit, and create the matching
GitHub release. The first release was v0.1.0; v0.1.1 contains the fixes listed in
[the CHANGELOG](../CHANGELOG.md).

1. Start from the latest reviewed main. Keep PAT mode documented; GitHub App mode
   remains deferred and will be an alternative to PAT mode when implemented.
2. Open `release/<version>` against main. Set the root version in `package.json`
   and both root version fields in `package-lock.json`; finalize the CHANGELOG
   heading with the release date. Keep every `private: true` and workspace
   version intact.
3. Run `npm run check` and require green CI and CodeQL on the release PR's head.
   CI exercises the real Gradle inventory acceptance tests. Report integration
   skips, and retain the [real-run evidence](validation.md).
4. Squash-merge the release PR and create a lightweight `v<version>` tag at
   **its exact merge commit**. Create the matching GitHub release with the fixes
   and a link to `CHANGELOG.md` for more information, as java-conventions does.
   Do not move an existing tag or publish packages.
5. When the reusable workflow or gate code changes, resolve the tag's full commit
   SHA and repin adopting workflows to
   `leanish/supply-chain/.github/workflows/supply-chain.yml@<full-sha> # v<version>`.
   Require green adoption PR checks before merging. Tool-only releases do not
   require gate repins.
6. Install tools from that release commit in a stable checkout outside `/tmp`.
   Use the [adoption guide](adopting-tools.md) and preserve the owner's configs
   and secret-service overrides when switching the scheduled runner. Do not put
   credentials in Git, release notes or scheduling files.

These steps release supply-chain only; consumer repository releases are separate
decisions. Subsequent development must not move a released tag or an adopter's pin.
