# Provenance

Everything in this package except the files marked **new** is copied from
[leanish/leanish-development](https://github.com/leanish/leanish-development) (private) at commit `e4f8a1e`
("installing the coding-agent CLIs from their own lockfile", the tip of its runtime stack), mostly from `core/runtime`.

**Why a copy:** secure-it and bump-it need these pieces to run a coding agent, and leanish-development's runtime isn't
public. The copy is temporary: a shared `leanish/agent-kit` that both repositories pin is the next step. Until then,
**a fix in one copy is replicated by hand in the other**; leanish-development's README lists the same files.

**In every copied file:** relative imports end in `.ts` instead of `.js` (this repository runs TypeScript directly with
Node's type stripping, so non-erasable syntax such as parameter properties is written out as fields). Comments that cite
ADRs, the agent descriptor or `AGENT_RUNTIME_*` variables refer to leanish-development; here the tools pass those
values from their own config.

**Not copied:** the framework (descriptors, `needs`, the catalog, dispatch, envelopes, self-publish, idempotency, AWS and
Lambda), and the target-credentials resolver (the tools pass the agent's read-only token themselves).

| File | Source | How | Local changes |
|---|---|---|---|
| `guard/gh` | `agents/bump-it/local/guard/gh` | copied | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool" |
| `guard/git` | `agents/bump-it/local/guard/git` | copied | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool" |
| `guard/lib.sh` | `agents/bump-it/local/guard/lib.sh` | copied | messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool" |
| `src/errors.ts` | `core/runtime/src/errors.ts` | copied | only the classes the copied modules use; parameter properties written as fields. |
| `src/github/github-client.ts` | `core/runtime/src/needs/github-client.ts` | copied | `GitHubApiError`'s parameter properties written as fields. |
| `src/isolation.ts` | core/runtime/src/runtime/run-local-cli.ts (`localCodexOptions`, `SENSITIVE_HOME_PATHS`) | derived | inputs from the tool's config; the configured commit identity instead of the developer's global one; the repository's release age |
| `src/logger/console-logger.ts` | `core/runtime/src/logger/console-logger.ts` | copied | — |
| `src/logger/correlation.ts` | `core/runtime/src/logger/correlation.ts` | copied | — |
| `src/logger/redactor.ts` | `core/runtime/src/logger/redactor.ts` | copied | — |
| `src/report/run-report.ts` | `core/runtime/src/runtime/run-report.ts` | copied | one tool command instead of a run-local dispatch loop: no dispatch, delayed-message or self-publish counts; `tool` and `repo` instead of `agent`; the command's `result` comes with its end. |
| `src/secret-store.ts` | — | new |  |
| `src/skill/claude-code-runner.ts` | `core/runtime/src/skill/claude-code-runner.ts` | copied | — |
| `src/skill/codex-command-env.ts` | `core/runtime/src/skill/codex-command-env.ts` | copied | — |
| `src/skill/codex-login.ts` | `core/runtime/src/skill/codex-login.ts` | copied | — |
| `src/skill/codex-model.ts` | `core/runtime/src/skill/codex-model.ts` | copied | — |
| `src/skill/codex-permissions.ts` | `core/runtime/src/skill/codex-permissions.ts` | copied | `Access` from `types/access.ts` instead of the agent descriptor. |
| `src/skill/codex-quota-baseline.ts` | `core/runtime/src/skill/codex-quota-baseline.ts` | copied | — |
| `src/skill/codex-rollouts.ts` | `core/runtime/src/skill/codex-rollouts.ts` | copied | — |
| `src/skill/codex-runner.ts` | `core/runtime/src/skill/codex-runner.ts` | copied | — |
| `src/skill/codex-usage-meter.ts` | `core/runtime/src/skill/codex-usage-meter.ts` | copied | — |
| `src/skill/fake-runner.ts` | `core/runtime/src/skill/fake-runner.ts` | copied | — |
| `src/skill/input-render.ts` | `core/runtime/src/skill/input-render.ts` | copied | — |
| `src/skill/output-parse.ts` | `core/runtime/src/skill/output-parse.ts` | copied | — |
| `src/skill/run-skill.ts` | `core/runtime/src/skill/run-skill.ts` | copied | the agent descriptor, `needs` and the target-credentials resolver are replaced by `SkillContext` (the tool's entrypoints and support skills) and `SkillCall` (coding agent, model, effort, access and the credential env, all from the tool's config). |
| `src/skill/runner.ts` | `core/runtime/src/skill/runner.ts` | copied | `Access` from `types/access.ts` instead of the agent descriptor. |
| `src/skill/schema-subset.ts` | `core/runtime/src/skill/schema-subset.ts` | copied | — |
| `src/skill/skill-loader.ts` | `core/runtime/src/skill/skill-loader.ts` | copied | — |
| `src/skill/skill.ts` | `core/runtime/src/skill/skill.ts` | copied | — |
| `src/skill/slash-command-prompt.ts` | `core/runtime/src/skill/slash-command-prompt.ts` | copied | — |
| `src/skill/spawn-capture.ts` | `core/runtime/src/skill/spawn-capture.ts` | copied | — |
| `src/skill/stage-skills.ts` | `core/runtime/src/skill/stage-skills.ts` | copied | — |
| `src/skill/synthesize-fixture.ts` | `core/runtime/src/skill/synthesize-fixture.ts` | copied | — |
| `src/skill/tail.ts` | `core/runtime/src/skill/tail.ts` | copied | — |
| `src/skill/validator.ts` | `core/runtime/src/skill/validator.ts` | copied | — |
| `src/skill/wc-mount.ts` | `core/runtime/src/skill/wc-mount.ts` | copied | — |
| `src/types/access.ts` | — | new |  |
| `src/types/clients.ts` | `core/runtime/src/types/clients.ts` | copied | only the GitHub client's types. |
| `src/types/logger.ts` | `core/runtime/src/types/logger.ts` | copied | — |
| `src/types/repo-source.ts` | — | new |  |
| `src/types/working-copy.ts` | `core/runtime/src/types/working-copy.ts` | copied | — |
| `src/usage/api-cost.ts` | `core/runtime/src/usage/api-cost.ts` | copied | — |
| `src/usage/model-prices.ts` | `core/runtime/src/usage/model-prices.ts` | copied | — |
| `src/usage/quota.ts` | `core/runtime/src/usage/quota.ts` | copied | — |
| `src/usage/skill-usage-record.ts` | `core/runtime/src/usage/skill-usage-record.ts` | copied | — |
| `src/usage/skill-usage.ts` | `core/runtime/src/usage/skill-usage.ts` | copied | — |
| `src/usage/usage-totals.ts` | `core/runtime/src/usage/usage-totals.ts` | copied | — |
| `src/working-copy/git-clone-auth.ts` | `core/runtime/src/working-copy/git-clone-auth.ts` | copied | `gitCloneAuth(token, host)` replaces `resolveGitCloneAuth(needs, env)`; the tool passes its token. |
| `src/working-copy/local-git-workspace.ts` | `core/runtime/src/working-copy/local-git-workspace.ts` | copied | `RepoSource` instead of catalog-it's `Project`. |
| `src/working-copy/workspace.ts` | `core/runtime/src/working-copy/workspace.ts` | copied | `RepoSource` instead of catalog-it's `Project`. |
| `test/api-cost.test.ts` | `core/runtime/test/unit/api-cost.test.ts` | copied | — |
| `test/claude-code-runner.test.ts` | `core/runtime/test/unit/claude-code-runner.test.ts` | copied | — |
| `test/codex-model.test.ts` | `core/runtime/test/unit/codex-model.test.ts` | copied | — |
| `test/codex-permissions.test.ts` | `core/runtime/test/unit/codex-permissions.test.ts` | copied | — |
| `test/codex-rollouts.test.ts` | `core/runtime/test/unit/codex-rollouts.test.ts` | copied | — |
| `test/codex-runner-access.test.ts` | `core/runtime/test/unit/codex-runner-access.test.ts` | copied | — |
| `test/codex-runner-usage.test.ts` | `core/runtime/test/unit/codex-runner-usage.test.ts` | copied | — |
| `test/codex-runner.test.ts` | `core/runtime/test/unit/codex-runner.test.ts` | copied | — |
| `test/correlation-and-redaction.test.ts` | `core/runtime/test/unit/correlation-and-redaction.test.ts` | copied | — |
| `test/fixtures/codex-rollout.ts` | `core/runtime/test/fixtures/codex-rollout.ts` | copied | — |
| `test/git-clone-auth.test.ts` | `core/runtime/test/unit/git-clone-auth.test.ts` | copied | `gitCloneAuth` tests replace the `resolveGitCloneAuth` ones. |
| `test/github-client.test.ts` | `core/runtime/test/unit/github-client.test.ts` | copied | — |
| `test/guard.test.ts` | `agents/bump-it/test/local-guard.test.ts` | copied | the guards' directory, and their messages say "agent guard". |
| `test/input-render.test.ts` | `core/runtime/test/unit/input-render.test.ts` | copied | — |
| `test/isolation.test.ts` | — | new |  |
| `test/local-git-workspace.test.ts` | `core/runtime/test/unit/local-git-workspace.test.ts` | copied | `RepoSource` instead of catalog-it's `Project`. |
| `test/model-prices.test.ts` | `core/runtime/test/unit/model-prices.test.ts` | copied | — |
| `test/output-parse.test.ts` | `core/runtime/test/unit/output-parse.test.ts` | copied | — |
| `test/quota.test.ts` | `core/runtime/test/unit/quota.test.ts` | copied | — |
| `test/run-report.test.ts` | — | new |  |
| `test/run-skill.test.ts` | core/runtime/test/unit/run-skill-usage.test.ts, run-skill-invocation.test.ts | adapted | the same cases against `SkillContext`/`SkillCall` |
| `test/schema-subset.test.ts` | `core/runtime/test/unit/schema-subset.test.ts` | copied | — |
| `test/skill-loader.test.ts` | `core/runtime/test/unit/skill-loader.test.ts` | copied | — |
| `test/spawn-capture-env.test.ts` | `core/runtime/test/unit/spawn-capture-env.test.ts` | copied | — |
| `test/stage-skills.test.ts` | `core/runtime/test/unit/stage-skills.test.ts` | copied | — |
| `test/usage-totals.test.ts` | `core/runtime/test/unit/usage-totals.test.ts` | copied | — |
| `test/wc-mount.test.ts` | `core/runtime/test/unit/wc-mount.test.ts` | copied | — |
