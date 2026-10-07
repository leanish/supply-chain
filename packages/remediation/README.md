# remediation

What secure-it and bump-it share. Each tool is its own command with its own config, schedule, skill and PRs; this
package is the code around them:

- **Config** (`config.ts`): `~/.config/leanish/<tool>/agent.yaml`, read strictly (unknown fields fail). It holds:
  - the repositories, each an explicit opt-in;
  - the coding agent, model and efforts (`majorEffort` for majors and their reviews);
  - the names of the two secrets (the tool's write token and the agent's read-only one);
  - the commit identity, the state and cache directories, and paths the agent may not read;
  - for secure-it, `staleScanHours`.

  What's about the repository (release age, own packages, registries) comes from its `.github/supply-chain.json`.
- **The tool's PRs** (`own-pr.ts`, `publication.ts`):
  - **Recognition:** a PR is the tool's when it comes from one of its branches (`<tool>/<date>-<topic>`) of the repository itself and carries its marker or its label (`leanish:agent=<tool>`).
  - **State:** the body records the head the tool pushed, the base it computed against, and how many times the agent adapted it.
  - **Race checks:** every write re-reads the PR first and stops unless it's still the tool's, open, and at the expected head.
- **The review tick** (`review.ts`) goes through every open PR of the tool, in this order:
  1. Someone else pushed: leave the PR alone.
  2. The base moved: the tool recomputes on the new base, before anything else.
  3. CI pending: nothing. Green: mark the PR ready. No model is used for 1 or 3.
  4. CI failed: the agent adapts, at most twice; after that, the PR is closed with a comment.

  A problem with one PR doesn't stop the others.
- **The command** (`command.ts`): `<tool> run|review <owner/repo> [--config <file>]`. It reads both tokens from the secret store and refuses identical ones. It syncs the working copy and runs the agent isolated, giving it only the read-only token. It always ends with one `run finished` line on stderr.
- **`run.sh`**: `run.sh <tool> run|review <owner/repo>`, what launchd or cron calls. It takes one lock per tool and repository (exit 75 while another run holds it), and writes the final line itself when it stops before the tool reports.

Parts adapted from leanish-development's bump-it are listed in [PROVENANCE.md](PROVENANCE.md).
