# supply-chain

Dependency security and freshness for npm, Gradle and GitHub Actions, with one
version/advisory policy shared by CI and the update tools.

- **The CI gate** compares base and head against one advisory snapshot. A PR fails
  on what it makes worse; malware always fails. Daily scans check the default
  branch and refresh the verdict on open PRs.
- **secure-it** batches actionable non-major security fixes, keeps malware fixes
  together, and opens a separate PR per major. It can remove redundant security
  floors only after a joint resolution without lockfiles proves them unnecessary.
- **bump-it** chooses the highest eligible versions under the release-age policy:
  one routine PR for minors, patches, npm transitives and Gradle wrappers, and one
  per major. The tool computes npm files and generates wrappers; a coding agent
  handles other edits and major adaptations. Every proposed change is verified.

The gate runs in GitHub Actions. The tools run on macOS and propose PRs; they do
not merge them. Node 24 is required; npm 11.17+ is needed for release-age exclusions.
Packages remain private: adoption uses a reviewed Git commit, with no npm publish.
The current release is **v0.2.0**; see the [CHANGELOG](CHANGELOG.md) for its changes.
Licensed under Apache-2.0.

## Adoption and operation

- [Why this adds value alongside dependency alerts](docs/why.md)
- [Adopting the gate](packages/ci/README.md#adopting-the-gate), including
  [repository policy, exceptions and floors](packages/ci/README.md)
- [Adopting secure-it and bump-it](docs/adopting-tools.md): per-tool Keychain
  defaults, PAT permissions, candidate preview, launchd, logs, costs and troubleshooting
- [Tool configuration](docs/tool-configuration.md): both agent.yaml files and links
  to the gate's configuration reference
- [Security model](docs/security-model.md) and [coverage gaps](docs/coverage-gaps.md)
- [Validation evidence](docs/validation.md): real wrapper and floor-removal proofs
- [Release procedure](docs/releasing.md) and [CHANGELOG](CHANGELOG.md)

Each tool uses distinct write/read PAT values. Default Keychain services are
`leanish-secure-it-write` / `leanish-secure-it-read` and
`leanish-bump-it-write` / `leanish-bump-it-read`; optional `secrets` overrides can
share a pair between tools. PR labels are `leanish:secure-it` and `leanish:bump-it`;
legacy labels remain recognised. GitHub App mode is future work; PAT mode will
remain supported when it arrives.

## Packages

- [`ci`](packages/ci): inventories, advisory/version rules, candidate selection and
  the reusable gate with daily open-PR rescans
- [`secure-it`](packages/secure-it): security batches, separate majors and verified
  removal of security floors; compatibility floors stay
- [`bump-it`](packages/bump-it): routine/major plans, tool-computed npm changes and
  checksummed Gradle wrapper generation
- [`remediation`](packages/remediation): shared config, sandboxed inventories,
  publication race checks and journal recovery, review ticks and `run.sh`
- [`agent-basics`](packages/agent-basics): coding-agent support copied from
  leanish-development's runtime, with [provenance](packages/agent-basics/PROVENANCE.md).
  Applicable fixes are mirrored by hand until both repos share an agent-kit.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

CI also sets `SUPPLY_CHAIN_GRADLE_TESTS=1` to exercise a real Gradle inventory.
Local checks skip those network/build tests unless enabled; the macOS Seatbelt
probe skips when this process cannot apply a nested sandbox. Neither skip proves
that integration boundary passed: inspect CI and the real-run evidence separately.
