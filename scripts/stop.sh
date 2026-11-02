#!/usr/bin/env bash
# Stop everything started by start.sh. Idempotent.
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_DIR="run"

stop_one() {
  local name="$1" pidfile="$RUN_DIR/$1.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 25); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$pid" 2>/dev/null
    echo "$name stopped (pid $pid)"
  else
    echo "$name was not running"
  fi
  rm -f "$pidfile"
}

stop_one caddy
stop_one node
