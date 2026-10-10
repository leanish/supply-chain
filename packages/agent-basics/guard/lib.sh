# Copied from leanish/leanish-development agents/bump-it/local/guard/lib.sh at c6282df; see PROVENANCE.md.
# Local changes: messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool".
# Shared by the agent guard shims (sourced, not executed). Guard rails for a
# local scheduled run, not a boundary: the agent could still call the real
# binaries by path, and private repos on GitHub Free have no branch protection.

guard_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

deny() {
  echo "agent guard: refused: $*" >&2
  exit 126
}

# The next executable named $1 on PATH after this guard's own directory.
real_bin() {
  local name=$1 dir resolved
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    resolved=$(cd "$dir" 2>/dev/null && pwd -P) || continue
    [ "$resolved" = "$guard_dir" ] && continue
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      echo "$dir/$name"
      return 0
    fi
  done
  echo "agent guard: no real '$name' on PATH" >&2
  exit 127
}
