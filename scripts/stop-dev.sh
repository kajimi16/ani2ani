#!/usr/bin/env bash
# Stop the dev stack. Safe to run from either worktree: it looks for the pid
# files where the stack actually lives (scripts/dev-worktree.sh runs it inside
# $DEV, so its pids are under $DEV/run-dev, not the main worktree's run-dev).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${DEV_WORKTREE:-$(cd "$HERE/.." && pwd)/ani2ani-dev}"

stop_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  for name in caddy node; do
    local pidfile="$dir/$name.pid"
    [[ -f "$pidfile" ]] || continue
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      echo "stopped $name (pid $pid) in $dir"
    fi
    rm -f "$pidfile"
  done
}

stop_dir "$HERE/run-dev"
[[ "$DEV" != "$HERE" ]] && stop_dir "$DEV/run-dev"

exit 0
