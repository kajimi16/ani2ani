#!/usr/bin/env bash
# Start the dev stack from a separate git worktree.
#
# The live Caddy serves ./web straight from disk on every request, so editing a
# file in the main worktree changes what viewers on :8080 get — no restart, no
# warning. A second stack is therefore not enough: the *files* must live
# somewhere else too. Everything below happens in $DEV, so the main worktree
# keeps serving exactly what it served before.
#
# The worktree lives on branch `dev`, not a detached HEAD: commits made there
# stay reachable and merge back with `git merge dev`.
set -euo pipefail
MAIN="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${DEV_WORKTREE:-$MAIN/../ani2ani-dev}"
BRANCH="${DEV_BRANCH:-dev}"

if [[ -e "$DEV/.git" ]]; then
  echo "reusing worktree $DEV"
  # A worktree created by an older version of this script sits on a detached
  # HEAD, where new commits are unreferenced. Attach it to the branch instead.
  if ! git -C "$DEV" symbolic-ref -q HEAD >/dev/null; then
    git -C "$DEV" checkout -B "$BRANCH"
    echo "attached worktree to branch $BRANCH"
  fi
else
  mkdir -p "$(dirname "$DEV")"
  git -C "$MAIN" worktree add -B "$BRANCH" "$DEV" HEAD
  echo "created worktree $DEV on branch $BRANCH"
fi

# Same dependencies and TLS material, no second copy. certs/ is gitignored, so a
# fresh worktree has none and Caddy refuses to load the mirror site without it.
if [[ ! -e "$DEV/node_modules" ]]; then
  ln -s "$MAIN/node_modules" "$DEV/node_modules"
fi
if [[ ! -e "$DEV/certs" && -d "$MAIN/certs" ]]; then
  ln -s "$MAIN/certs" "$DEV/certs"
fi
[[ -f "$DEV/web/player.js" ]] || (cd "$DEV" && bash scripts/build-player.sh)

main_head="$(git -C "$MAIN" rev-parse --short HEAD)"
dev_head="$(git -C "$DEV" rev-parse --short HEAD)"
echo "main HEAD: $main_head ($(git -C "$MAIN" log -1 --format=%s))"
echo "dev  HEAD: $dev_head"
behind="$(git -C "$DEV" rev-list --count "HEAD..$main_head" 2>/dev/null || echo 0)"
if [[ "$behind" != "0" ]]; then
  echo "warn: dev 落后 main $behind 个提交，先 git -C \"$DEV\" merge $main_head 再测，否则测的是旧代码"
fi

cd "$DEV"
echo "working tree: $DEV (branch $BRANCH)"
bash scripts/start-dev.sh
