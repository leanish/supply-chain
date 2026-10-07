# Adopting secure-it and bump-it

The tools run on your machine and propose draft PRs; people merge them. Each has
its own config, two tokens and two schedules: `run` plans changes, `review`
revisits its open PRs. Either command can push or change a PR. There is currently
**no tool dry-run flag**. Start with the candidate preview below before enabling
publication or a schedule.

Adopt [the CI gate](../packages/ci/README.md#adopting-the-gate) first: default-branch
daily scans, PR comparisons and open-PR rescans are what these tools act on and
read. They do not replace R7's CI coverage. Read [the security model](security-model.md)
and [coverage gaps](coverage-gaps.md) before giving a tool repository access.

## Prerequisites

- **macOS, currently Apple Silicon:** the secret store uses macOS Keychain,
  `run.sh` uses `lockf`, and the pinned scanner has a macOS arm64 build. Linux's
  scanner pin does not make the current Keychain launcher portable.
- **Node 24 or newer**, git, `gh`, npm and Codex available on the command path.
  Use **npm 11.17.0 or newer** whenever there are own npm scopes, planned young
  security targets or young/unreadable locked base versions: these need
  `min-release-age-exclude`. Older npm reports the affected unit failed, with
  the needed exclusions and detected version, before publication. Using 11.17+
  from the start avoids that conditional failure.
- **Codex login** for the same user that will run launchd. The runner reuses a
  file-backed `auth.json` under `$CODEX_HOME` or `~/.codex`; a keyring-only login
  cannot be reused. See [Codex credential storage](https://developers.openai.com/codex/auth/#credential-storage).
  For a file-backed login, run:

  ```bash
  codex -c 'cli_auth_credentials_store="file"' login
  test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"
  codex --version
  codex debug models
  ```

  Do not copy credentials into this repository or a plist. Choose a listed model
  and supported efforts; `sol` resolves against that CLI's catalog. The CLI must
  support the sandbox/profile options this runner uses; run from a normal macOS
  login session, not inside a sandbox that prevents Seatbelt from being applied.
- For Gradle repositories, **a suitable JDK** and their checked-in executable
  `gradlew`. Add `JAVA_HOME` to launchd's environment if your installation needs
  it. Gradle runs build code under the tool's sandbox and can access the network.
- Network access for GitHub, OSV and the repository's allowed registries; wrapper
  updates also read services.gradle.org. The pinned OSV-Scanner installs itself
  under protected tool state. These are real registry/model calls, not fake tests.

Keep a stable checkout of supply-chain, outside `/tmp`, and install its locked
dependencies without scripts:

```bash
git clone https://github.com/leanish/supply-chain.git "$HOME/dev/supply-chain"
cd "$HOME/dev/supply-chain"
# Check out the reviewed tool release/commit you intend to run.
npm ci --ignore-scripts
node --version
npm --version
```

The tools create their own working copies; they do not edit the adopting repo's
developer checkout. Update this launcher checkout deliberately, with checks, and
keep its path unchanged in your schedules.

## Two fine-grained PATs per tool

Create **four distinct fine-grained PATs** if adopting both tools. For each,
select the resource owner and only the repositories that tool's `repos` lists;
use an expiry and renew the matching Keychain item before it expires. The token
owner must be allowed to push branches and create PRs, and an organization may
need to approve the tokens. The current config has one pair per tool; use
separate configs/launchers when different resource owners need different pairs.

| Repository permission | Tool's write PAT | Agent's read PAT |
|---|---|---|
| Contents | Read and write | Read-only |
| Pull requests | Read and write | Read-only |
| Workflows | Read and write | No access |
| Actions | Read-only | Read-only |
| Commit statuses | Read-only | Read-only |
| Metadata | Read-only (automatic) | Read-only (automatic) |
| Checks | **No access** | **No access** |

Leave other permissions and account permissions unset. Workflows write permits
pushing action-pin changes in workflow files; it does not grant Actions write.
Pull requests write also covers PR labels/comments via the Issues endpoints;
Issues permission is unnecessary. The tool's client reads CI from Actions
workflow runs/jobs and commit statuses. The owner's real-run PATs have no Checks
permission; checks-only results from other apps must be exposed as commit statuses
to be seen. This permission set follows [GitHub's fine-grained permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and the [copied client](../packages/agent-basics/src/github/github-client.ts).

The write PAT stays in the publisher process. Only the read PAT reaches the
agent as `GH_TOKEN`; tool-run repository commands get no token. Never export the
write PAT into your shell or put either PAT's value in `agent.yaml` or a plist.
`gh auth login` is a separate operator convenience, not the tools' secret source.

## Keychain and agent.yaml

In **Keychain Access**, add a generic password item in your login keychain for
each service below (Keychain Item Name is the service, account is your GitHub
login, password is the corresponding PAT). Use the UI so tokens are not in shell
history or command arguments.

| Tool | Write service | Read service |
|---|---|---|
| secure-it | `leanish-secure-it-github` | `leanish-secure-it-github-read` |
| bump-it | `leanish-bump-it-github` | `leanish-bump-it-github-read` |

The tools look up each service with `security find-generic-password -s <service>
-w`; they refuse identical services or values. Unlock/authorize the login
keychain in your interactive session before scheduling. Do not print passwords
into diagnostic logs.

```bash
mkdir -p "$HOME/.config/leanish/secure-it" "$HOME/.config/leanish/bump-it"
cp docs/examples/secure-it-agent.yaml "$HOME/.config/leanish/secure-it/agent.yaml"
cp docs/examples/bump-it-agent.yaml "$HOME/.config/leanish/bump-it/agent.yaml"
chmod 600 "$HOME/.config/leanish/secure-it/agent.yaml" "$HOME/.config/leanish/bump-it/agent.yaml"
```

Edit the copies: opt in each `owner/repo`, choose the base branch or omit it to
use the default, set the commit identity, and add private folders to `readDeny`.
Use separate default state/cache directories under home. OSV's state path must
not be under the build cache, a writable working copy or temp roots (including
`/tmp` and its canonical macOS path `/private/tmp`). See the complete
[config reference](tool-configuration.md); repository policy, exceptions and
floors have existing gate references linked there.

## First dry run: candidate preview

This preview calls the gate's deterministic candidate rules. It reads a committed
checkout, queries registries/advisories and writes JSON; it does **not** invoke a
model, push, open a PR or run repository build code. Set `TARGET` to a clean local
checkout at the intended base commit. The scanner installer downloads the pinned
binary and verifies its hash. Use a read PAT, never the write PAT:

```bash
cd "$HOME/dev/supply-chain"
TARGET="$HOME/dev/widget"
PREVIEW="$HOME/.local/share/leanish/candidate-preview"
mkdir -p "$PREVIEW"
OSV_SCANNER="$(packages/ci/scripts/install-osv-scanner.sh "$PREVIEW/tools")"
GH_TOKEN="$(security find-generic-password -s leanish-secure-it-github-read -w)" \
  OSV_SCANNER="$OSV_SCANNER" node packages/ci/src/cli.ts candidates \
  --rule security --repo "$TARGET" --head HEAD --out "$PREVIEW/security.json"
GH_TOKEN="$(security find-generic-password -s leanish-bump-it-github-read -w)" \
  OSV_SCANNER="$OSV_SCANNER" node packages/ci/src/cli.ts candidates \
  --rule bump --repo "$TARGET" --head HEAD --out "$PREVIEW/bump.json"
```

For a Gradle repo, add `--head-gradle /absolute/path/gradle-head.json` to both
commands, using that exact commit's inventory from a successful gate run (the
`gradle-head` artifact). Its commit/build list is validated. For example, download
the artifact with `gh run download RUN_ID --repo acme/widget --name gradle-head
--dir "$PREVIEW/inventory"`. A missing or mismatched inventory fails closed.
Do not substitute `--head worktree` to avoid this: that gate CLI mode runs Gradle
inline, outside the tools' sandbox.

Read `incomplete`, blockers and coverage gaps as well as candidates. Exit 2 means
the preview could not complete; an empty list then does not mean clean. This is
**not a full tool simulation**: it does not compute the final npm bytes/transitive
refresh, assemble peer-coupled units, prove floor removals, select/generate wrapper
updates or verify an agent's edits. The first actual tool run below can publish.

## First manual publication and review

Run one opted-in repository interactively before installing schedules. These
commands may open/update draft PRs. Review may also mark them ready or close them;
neither merges them.

```bash
cd "$HOME/dev/supply-chain"
mkdir -p "$HOME/Library/Logs/leanish"
packages/remediation/run.sh secure-it run acme/widget \
  >"$HOME/Library/Logs/leanish/secure-it.widget.run.out.log" \
  2>"$HOME/Library/Logs/leanish/secure-it.widget.run.err.log"
packages/remediation/run.sh bump-it run acme/widget \
  >"$HOME/Library/Logs/leanish/bump-it.widget.run.out.log" \
  2>"$HOME/Library/Logs/leanish/bump-it.widget.run.err.log"
packages/remediation/run.sh secure-it review acme/widget
packages/remediation/run.sh bump-it review acme/widget
```

Check the final report, proposed diff and CI. secure-it batches non-major fixes,
keeps malware together first, separates majors, and can open a separate verified
floor-removal PR. bump-it batches routine updates and separates majors, with a
new-major cap. A recognised same-plan open PR is reported as already open; a human
push is left alone. [secure-it's behavior](../packages/secure-it/README.md) and
[bump-it's behavior](../packages/bump-it/README.md) explain verification and review.

## launchd: run and review

Use user **LaunchAgents**, in the same logged-in user's GUI session as the
Keychain/Codex login. Copy these four examples to `~/Library/LaunchAgents`:

| Plist | Example schedule |
|---|---|
| [secure-it run](examples/leanish.secure-it.widget.run.plist) | Daily 07:17 |
| [secure-it review](examples/leanish.secure-it.widget.review.plist) | Every four hours |
| [bump-it run](examples/leanish.bump-it.widget.run.plist) | Monday 08:23 |
| [bump-it review](examples/leanish.bump-it.widget.review.plist) | Every four hours |

Replace **every** `/Users/YOUR_USER`, `acme/widget`, label/log suffix, and PATH.
launchd does not expand `~`, `$HOME` or shell commands in a plist. Ensure its PATH
finds the same Node/npm/Codex you tested interactively (include your version
manager's actual bin directory if applicable). The examples set HOME explicitly
and use absolute launcher, config and log paths. They contain no tokens. Create
the log directory before loading them; use a distinct label and logs per repo,
tool and command.

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/leanish"
cp docs/examples/leanish.*.widget.*.plist "$HOME/Library/LaunchAgents/"
# Edit those four copies before loading; shown for one, repeat for the others:
PLIST="$HOME/Library/LaunchAgents/leanish.secure-it.widget.run.plist"
plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/leanish.secure-it.widget.run"
# Explicitly trigger a live run, only when ready to publish:
launchctl kickstart "gui/$(id -u)/leanish.secure-it.widget.run"
# Stop/unload the schedule:
launchctl bootout "gui/$(id -u)" "$PLIST"
```

Calendar times use the machine's local timezone. A sleeping/offline/logged-out
machine is not a dependable CI scheduler; the gate's daily scan stays in Actions.
The examples omit `RunAtLoad` and `KeepAlive` to avoid an unexpected first run or
a retry loop. `run.sh` serializes run/review per tool/repo; a busy lock reports
exit 75, so let the next tick handle it. Different tools have separate locks.

## Logs and costs

Stdout and stderr go to the plist's log files. The final stderr JSON line has
`msg: "run finished"`: `status`/`exitCode` describe command completion;
`result` contains each unit/PR's business outcome. **An exit 0 can still contain
blocked, failed or deferred units.** Inspect the nested result and reasons,
not only launchd's last exit code. `run.sh` supplies a final line when startup or
locking fails. Keep/rotate logs under your own retention policy; launchd does not
rotate these files. They may contain repository details and model responses.

`skills` and `totals` record model calls, measured tokens, available quota
observations, API-equivalent cost estimates and gaps. Incomplete measurements use
lower bounds, not invented zero cost. Configure a dated [price table](tool-configuration.md#optional-price-table)
for cost estimates; these are not a subscription bill. `maxNewMajorsPerRun` limits
new-major volume, not total spend. Pending/green review ticks use no model; base
reconciliation and failed-CI adaptations can. npm/wrapper-only bump-it routines
need no model, while majors use `majorEffort`. Failed attempts also consume usage.

## Troubleshooting real runs

| Symptom | Cause and action |
|---|---|
| OSV-Scanner refused because sandboxed commands can write its path | `dirs.state` was placed under `/tmp`, cache or a writable checkout. Move state to its default home path, outside those roots; do not bypass the check. Stop schedules while moving state so publication journals and workspace metadata move together. A symlink alias is canonicalized, not an escape. |
| Gradle `fileHashes.lock (Operation not permitted)` although plain writes work | A reused daemon retained an earlier sandbox's writable root. Inventories, floor probes and wrapper generation now use `--no-daemon`: any daemon is single-use. Update to this implementation; keep this flag on custom tool-run Gradle commands. `GRADLE_OPTS` and repository JVM settings are not overwritten. Tool builds never reuse agent-started daemons. |
| npm `notarget` for a young version already locked | npm's own age window can reject even a previously accepted security fix. The tools report young/unreadable locked-base exclusions (and secure-it's planned young targets); npm >=11.17 reads them. The tool's targets and `compare` still enforce the agreed policy. Do not globally turn off the window. Check the npm version on **launchd's** PATH. |
| Peer-coupled major reported blocked (e.g. Vitest/UI/coverage) | Compatible peer companions are planned together by code. A set requiring coordinated cross-major moves is not supported: it is blocked with a reason, not "nothing to move." Other units continue; bump-it retains a peer-blocked major PR on review. Migrate that set manually or wait for a compatible set; do not loosen verification. |
| Codex usage limit or cannot-apply | The affected unit reports failure and publishes nothing unverified; inspect its reason and usage/quota gaps. Wait for quota recovery, pause/unload schedules if needed, then retry deliberately. A started CI adaptation consumes an attempt even if it fails (at most two); a tool may eventually close the PR. Reducing the new-major cap limits new work, not retries on existing PRs. |
| Keychain/login works interactively but launchd fails | Check service names, token expiry/repo approval, the logged-in user and unlocked keychain; check absolute PATH/HOME and the file-backed Codex login. Keyring-only login is not reused. Do not add credentials to a plist as a workaround. |
| CI results unavailable or pending | Grant Actions and Commit statuses read to the write PAT; Checks permission is unnecessary. Confirm the workflow/status is on the PR head SHA. Other apps' checks-only results are outside this client's coverage. |

The D2 Gradle floor probe has run against java-conventions: the Guava security
floor was **retained**, because parents still resolve vulnerable Guava without
it. That is a successful refusal, not a removal proof. E2 wrapper generation has
network-free fake tests but **has not yet run against a real Gradle project**;
inspect the first generated four-file diff and CI before merging a wrapper PR.
