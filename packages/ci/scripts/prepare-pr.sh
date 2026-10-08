#!/usr/bin/env bash
# Checks out, in the repository at the current directory, what an open PR would land on its base: the PR head merged
# into the given base commit. The merge is built with a fixed identity and dates, so every job that runs this for the
# same PR, head and base gets the same commit. When the merge conflicts, it checks out the PR head itself and compares
# it with its merge base. Prints `base=<sha>` and `head=<sha>`, for $GITHUB_OUTPUT.
#   prepare-pr.sh <pr-number> <head-sha> <base-sha>
set -euo pipefail

number=${1:?usage: prepare-pr.sh <pr-number> <head-sha> <base-sha>}
head_sha=${2:?usage: prepare-pr.sh <pr-number> <head-sha> <base-sha>}
base_sha=${3:?usage: prepare-pr.sh <pr-number> <head-sha> <base-sha>}

# The checkout keeps no credentials (the build runs later in some jobs); a private repository needs them for this one
# fetch, so GIT_FETCH_TOKEN, when set, goes in a header for this command only.
auth=()
if [ -n "${GIT_FETCH_TOKEN:-}" ]; then
  basic=$(printf 'x-access-token:%s' "$GIT_FETCH_TOKEN" | base64 | tr -d '\n')
  auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $basic")
fi
git "${auth[@]}" fetch --no-tags --quiet origin "+refs/pull/$number/head:refs/remotes/pull/$number/head" "$base_sha"
actual=$(git rev-parse "refs/remotes/pull/$number/head")
if [ "$actual" != "$head_sha" ]; then
  echo "PR #$number head moved to $actual since the rescan listed $head_sha" >&2
  exit 3
fi

when=$(git show -s --format=%cI "$head_sha")
export GIT_AUTHOR_NAME=supply-chain GIT_AUTHOR_EMAIL=supply-chain@localhost GIT_AUTHOR_DATE="$when"
export GIT_COMMITTER_NAME=supply-chain GIT_COMMITTER_EMAIL=supply-chain@localhost GIT_COMMITTER_DATE="$when"
git checkout --quiet --detach "$base_sha"
if git merge --quiet --no-ff --no-edit -m "supply-chain rescan of #$number" "$head_sha" > /dev/null 2>&1; then
  echo "base=$base_sha"
  echo "head=$(git rev-parse HEAD)"
else
  git merge --abort
  git checkout --quiet --detach "$head_sha"
  echo "base=$(git merge-base "$base_sha" "$head_sha")"
  echo "head=$head_sha"
fi
