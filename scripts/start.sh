#!/usr/bin/env bash
# Start the whole stack in user space. No sudo, no systemd, no privileged ports.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
API_PORT="${API_PORT:-8001}"
STUN_PORT="${STUN_PORT:-3478}"
RUN_DIR="run"
LOGS="logs"

# Segment cache policy. Default keeps immutable caching (correct for an actual
# screening); measurement runs must export SEGMENT_CACHE_CONTROL=no-store so warm
# browser caches cannot serve segments without a request reaching Caddy.
export SEGMENT_CACHE_CONTROL="${SEGMENT_CACHE_CONTROL:-public, max-age=31536000, immutable}"

# Disk headroom kept free for the OS and for live screening reads. Uploads are
# refused (507) rather than allowed to fill the filesystem, because a full root
# partition takes down the whole machine — including a screening in progress.
export ROOM_DISK_RESERVE_MB="${ROOM_DISK_RESERVE_MB:-2048}"

# Where room sources and segments live. The root filesystem is often full while
# another volume has room; point this at the roomy one instead of starving uploads.
export ROOM_DATA_DIR="${ROOM_DATA_DIR:-$PWD/data}"
# Keep the uploaded source after a successful transcode? Off by default: the
# segments are enough to screen, and the source costs about as much again.
export ROOM_KEEP_SOURCE="${ROOM_KEEP_SOURCE:-0}"
# Caddy serves /media/<room>/hls/* from here; must track ROOM_DATA_DIR.
export ROOM_MEDIA_ROOT="${ROOM_MEDIA_ROOT:-$ROOM_DATA_DIR/rooms}"

mkdir -p "$RUN_DIR" "$LOGS"

if [[ ! -f web/player.js ]]; then
  bash scripts/build-player.sh
fi

if [[ -f "$RUN_DIR/node.pid" ]] && kill -0 "$(cat "$RUN_DIR/node.pid")" 2>/dev/null; then
  echo "node already running (pid $(cat "$RUN_DIR/node.pid"))"
else
  API_PORT="$API_PORT" STUN_PORT="$STUN_PORT" \
    nohup node src/server.js >>"$LOGS/control.log" 2>&1 &
  echo $! >"$RUN_DIR/node.pid"
  echo "node started (pid $!) on api/$API_PORT stun-udp/$STUN_PORT"
fi

if [[ -f "$RUN_DIR/caddy.pid" ]] && kill -0 "$(cat "$RUN_DIR/caddy.pid")" 2>/dev/null; then
  echo "caddy already running (pid $(cat "$RUN_DIR/caddy.pid"))"
else
  nohup caddy run --config caddy/Caddyfile --adapter caddyfile \
    >>"$LOGS/caddy.log" 2>&1 &
  echo $! >"$RUN_DIR/caddy.pid"
  echo "caddy started (pid $!) on http/$PORT"
fi

for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    # First global IPv4 on a real NIC: VPN tunnels (Mihomo/tun) and docker
    # bridges are excluded, since viewers must reach the campus-facing address.
    primary="$(ip -4 -o addr show scope global 2>/dev/null \
      | awk '$2 !~ /^(br-|docker|veth|tun|tap|virbr|Mihomo|lo)/ {sub(/\/.*/,"",$4); print $4; exit}')"
    echo "stack ready:"
    echo "  local  http://127.0.0.1:$PORT/"
    [[ -n "$primary" ]] && echo "  campus http://$primary:$PORT/   (share this with viewers)"
    echo "  tracker wss://<host>:$PORT/tracker  stun: udp/$STUN_PORT"
    echo "  segment cache: $SEGMENT_CACHE_CONTROL"
    echo "  media dir: $ROOM_DATA_DIR (free: $(df -h "$ROOM_DATA_DIR" 2>/dev/null | awk 'NR==2{print $4}'))"
    echo "  upload reserve: ${ROOM_DISK_RESERVE_MB} MiB, keep source: ${ROOM_KEEP_SOURCE}"
    exit 0
  fi
  sleep 0.2
done

echo "stack failed to become ready; see $LOGS/control.log and $LOGS/caddy.log" >&2
exit 1
