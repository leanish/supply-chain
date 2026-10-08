#!/bin/bash
# Adapted from leanish/leanish-development agents/bump-it/local/run.sh at e4f8a1e: for any tool of this repository,
# with owner/slug checked as the tool checks it;
# the tool itself reads its config and tokens, so this script reads no secret and sets no runtime variables.
#
# Runs one secure-it or bump-it command for one repository on this machine, the way launchd or cron does:
#
#   run.sh <tool> run|review <owner/repo> [--config <agent.yaml>]
#
# - One command per tool and repository at a time (lockf, whose lock the kernel drops however the run
#   ends): exit 75 (EX_TEMPFAIL) while another holds it. Locks live under
#   ${XDG_STATE_HOME:-~/.local/state}/leanish/<tool>/locks.
# - Every execution ends with one `run finished` JSON line on stderr: the tool's own once it confirms it
#   reports (it writes the TOOL_REPORT_MARKER file); otherwise — arguments, the tool's files, the lock,
#   or Node failing to start — this script's, in the same shape, with the `phase` it stopped in.
set -euo pipefail

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%d", time() * 1000)' 2>/dev/null || echo $(($(date +%s) * 1000))
}
started_ms=$(now_ms)
phase=arguments
tool_field=
repo_field=
# Who writes the final line: this script (`self`), the run under the lock, or the tool. Each takes over
# by writing into its marker file: the locked run as it starts, the tool once its own reporting is in place.
reporter=self
lock_marker=
tool_marker=
final_line() {
  local code=$?
  if [ -n "$lock_marker" ]; then
    [ -s "$lock_marker" ] && reporter=locked-run
    rm -f "$lock_marker"
  fi
  if [ -n "$tool_marker" ]; then
    [ -s "$tool_marker" ] && reporter=tool
    rm -f "$tool_marker"
  fi
  [ "$reporter" = self ] || return 0
  local status=error level=error
  [ "$code" -eq 0 ] && status=ok level=info
  [ "$code" -gt 128 ] && status=interrupted
  local zero='{"input":0,"cachedInput":0,"cacheWriteInput":0,"output":0,"reasoningOutput":0,"total":0}'
  printf '{"ts":"%s","level":"%s","msg":"run finished",%s%s"source":"run.sh","phase":"%s","status":"%s","exitCode":%d,"error":"run.sh stopped at %s, before the tool reported (exit %d)","durationMs":%d,"skills":[],"totals":{"skillRuns":0,"skillRunsInProgress":0,"tokens":%s,"tokensLowerBound":%s,"estimatedApiCostUsd":0,"estimatedApiCostUsdLowerBound":0,"pricingBases":[],"gaps":[]}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$tool_field" "$repo_field" "$phase" "$status" "$code" "$phase" "$code" \
    "$(($(now_ms) - started_ms))" "$zero" "$zero" >&2
}
trap final_line EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  echo "usage: run.sh secure-it|bump-it run|review <owner/repo> [--config <agent.yaml>]" >&2
  exit 64
}
[ "$#" -ge 3 ] || usage
tool=$1
command=$2
repo=$3
shift 3
case "$tool" in secure-it|bump-it) ;; *) usage ;; esac
case "$command" in run|review) ;; *) usage ;; esac
# owner/slug as the tool checks it: no leading or trailing dot or dash, so `..` can't name a repository.
[[ "$repo" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$ ]] || usage
tool_field="\"tool\":\"$tool\","
repo_field="\"repo\":\"$repo\","
phase=tool-files

here=$(cd "$(dirname "$0")" && pwd -P)
cli=${TOOL_CLI:-$here/../$tool/src/cli.ts}
[ -f "$cli" ] || { echo "run.sh: no $tool command at $cli" >&2; exit 78; }

locks=${XDG_STATE_HOME:-$HOME/.local/state}/leanish/$tool/locks
mkdir -p "$locks"
lock="$locks/${repo//\//_}.lock"
if [ "${TOOL_LOCK_HELD:-}" != "$lock" ]; then
  phase=lock
  lock_marker=$(mktemp "${TMPDIR:-/tmp}/$tool-run.XXXXXX")
  status=0
  # The locked run is a child (not exec'd) so this one can still report a run the lock refused.
  TOOL_LOCK_HELD=$lock TOOL_LOCK_MARKER=$lock_marker lockf -k -t 0 "$lock" "$BASH" "$0" "$tool" "$command" "$repo" "$@" || status=$?
  exit "$status"
fi
# Under the lock: this run reports from here on.
[ -n "${TOOL_LOCK_MARKER:-}" ] && printf 'locked run\n' > "$TOOL_LOCK_MARKER"
unset TOOL_LOCK_MARKER

phase=tool-start
tool_marker=$(mktemp "${TMPDIR:-/tmp}/$tool-tool.XXXXXX")
status=0
TOOL_REPORT_MARKER="$tool_marker" node "$cli" "$command" "$repo" "$@" || status=$?
exit "$status"
