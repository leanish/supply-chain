# Provenance

Parts of this package are adapted from [leanish/leanish-development](https://github.com/leanish/leanish-development) (private) at `e4f8a1e`, from its bump-it agent. As with [`agent-basics`](../agent-basics/PROVENANCE.md), the copy is temporary: a fix in one copy is replicated by hand in the other until a shared `leanish/agent-kit` replaces both.

| File | Source | How | Local changes |
|---|---|---|---|
| `src/ci-state.ts` | `agents/bump-it/src/ci-state.ts` | copied | `CiConclusion` defined here instead of bump-it's handler type |
| `src/own-pr.ts` | `agents/bump-it/src/own-pr.ts` | adapted | one set of rules per tool instead of bump-it's constants; the PR's state (pushed head, base, adaptations) in its body |
| `src/publication.ts` | `agents/bump-it/src/publication.ts` | adapted | parametrised by the tool's rules; several open PRs per tool; workspace and logger passed in instead of the runtime; no Dependabot closing; the PR's state recorded on every publication |
| `run.sh` | `agents/bump-it/local/run.sh` | adapted | for any tool; owner/slug checked like the tool does; no secrets or runtime variables (the tool reads its own) |
| `test/ci-state.test.ts` | `agents/bump-it/test/ci-state.test.ts` | copied | imports |
| `test/fake-github.ts` | `agents/bump-it/test/fake-github.ts` | adapted | secure-it's rules and PR state; no Dependabot PR factory |
| `test/run-sh.test.ts` | `agents/bump-it/test/local-run.test.ts` | adapted | the lock, the final-line handshake and the phases, with a fake tool command |
| `src/config.ts`, `src/review.ts`, `src/command.ts`, `src/journal.ts`, `src/sandboxed.ts` and their tests | — | new | — |
