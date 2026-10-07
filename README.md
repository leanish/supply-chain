# supply-chain

Dependency security and freshness for npm and Gradle repositories:

- a **CI gate** ([`packages/ci`](packages/ci)) that reads base and head against one advisory snapshot and fails a pull request only on what it makes worse; malware always fails;
- **secure-it**, which fixes security findings at any depth with the smallest change;
- **bump-it**, which keeps dependencies fresh: one PR for minors and patches, one per major.

Work in progress: the pieces land through pull requests. Licensed under Apache-2.0.

- [Why this, and not just Dependabot, OSV-Scanner or Renovate](docs/why.md)
- [Adopting the gate](packages/ci/README.md#adopting-the-gate), and everything it checks: [`packages/ci/README.md`](packages/ci/README.md)
- [Security model](docs/security-model.md): what runs where, and which token it can reach
- [Coverage gaps](docs/coverage-gaps.md)
- [`packages/secure-it`](packages/secure-it): batches non-major fixes from the gate's full scan, each major apart, and opens verified draft PRs
- [`packages/bump-it`](packages/bump-it): one routine PR for minor/patch updates and npm transitives, each major separately, verified before publication
- [`packages/remediation`](packages/remediation): what secure-it and bump-it share: config, their PRs (publication with race checks, review ticks), the command around a run and `run.sh`
- [`packages/agent-basics`](packages/agent-basics): running a coding agent for secure-it and bump-it, copied for now from leanish-development's runtime ([provenance](packages/agent-basics/PROVENANCE.md))

## Development

```bash
npm ci --ignore-scripts
npm run check
```
