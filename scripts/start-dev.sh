#!/usr/bin/env bash
# Second, fully isolated stack for trying changes: 8081 (HTTP) + 8002 (API),
# its own data/run/log trees. The live stack on 8080 keeps serving viewers, so a
# screening is never interrupted by an edit.
#
# Ports, room data, pids and logs are disjoint from production. Frontend files
# are NOT: Caddy serves ./web straight from disk on every request, so editing
# web/ in the main worktree changes what viewers on :8080 get immediately. Run
# this from a separate worktree (scripts/dev-worktree.sh) to isolate those too.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${DEV_PORT:-8081}"
export API_PORT="${DEV_API_PORT:-8002}"
export STUN_PORT="${DEV_STUN_PORT:-3479}"
export MIRROR_PORT="${DEV_MIRROR_PORT:-8444}"
export RUN_DIR="run-dev"
export LOGS="logs-dev"
export LOG_DIR="./logs-dev"
export ROOM_DATA_DIR="$PWD/data-dev"
export ROOM_MEDIA_ROOT="$ROOM_DATA_DIR/rooms"
# Mirrors advertise the production origin; pointless while testing locally.
export MEDIA_MIRRORS=""

mkdir -p "$RUN_DIR" "$LOGS" "$ROOM_MEDIA_ROOT"

bash scripts/start.sh
echo "dev stack: http://127.0.0.1:$PORT/  (data: $ROOM_DATA_DIR)"
