# Releasing supply-chain

The current development version is `0.1.0-SNAPSHOT`. It prepares the first release;
no `v0.1.0` tag or release is implied until the steps below are complete. All
workspace packages remain private. Consumers use a reviewed Git commit; there is
no npm publication.

The release flow follows java-conventions: prepare changes in the development
CHANGELOG, merge a small release PR dropping `-SNAPSHOT`, tag its merge commit,
then create the matching GitHub release pointing readers to the CHANGELOG.

1. Merge the reviewed supply-chain stack, including its Ubuntu runner tip. Keep
   PAT mode documented; GitHub App mode is deferred and will remain an alternative
   to PAT mode when implemented.
2. Run `npm run check` and the real Gradle-enabled CI acceptance tests on the final
   candidate. Check the gate's base/head jobs and verdict, and report integration
   skips. Review the [real-run evidence](validation.md).
3. Open `release/0.1.0` against main. Change only the root version from
   `0.1.0-SNAPSHOT` to `0.1.0` in `package.json` and both root version fields in
   `package-lock.json`; finalize the CHANGELOG heading with the release date.
   Keep every `private: true` and workspace version intact.
4. After that PR's CI passes and it merges, create a lightweight `v0.1.0` tag at
   **its exact merge commit**, then a GitHub release named `v0.1.0`. Use the notes
   `See \`CHANGELOG.md\` for more information`, as java-conventions does. Do not move
   an existing tag or publish packages.
5. Resolve the tag's full commit SHA and repin adopting workflows to
   `leanish/supply-chain/.github/workflows/supply-chain.yml@<full-sha> # v0.1.0`.
   Validate PR checks, default-branch daily scans and open-PR rescans before
   retiring an adopting repository's old gate/update producers.
6. Install tools from that reviewed release commit in a stable checkout outside
   `/tmp`. Use the [adoption guide](adopting-tools.md); do not put credentials in
   Git, release notes or launchd plists.

These steps release supply-chain only; consumer repository releases are separate
decisions. A subsequent development snapshot must not change the released tag or
an adopter's pin.
