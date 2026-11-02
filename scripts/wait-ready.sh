#!/usr/bin/env bash
# Pre-flight readiness wait. Kept in its own file so measure-round.sh stays
# readable and so this check can be run on its own:
#   bash scripts/wait-ready.sh [min_ready] [timeout_s]
#
# Why: a page left open from an earlier build keeps playing while reporting zero
# bytes, because its bundle predates the counters. A 4-minute round would then be
# spent discovering that. Require peers that are simultaneously live, playing, and
# actually moving bytes.
set -uo pipefail
cd "$(dirname "$0")/.."

MIN_READY="${1:-3}"
WAIT_S="${2:-90}"
PORT="${PORT:-8080}"
BASE="http://127.0.0.1:$PORT"

deadline=$(( $(date +%s) + WAIT_S ))
echo "waiting up to ${WAIT_S}s for ${MIN_READY} peers that are playing and moving bytes..."

while :; do
  if python3 - "$BASE" "$MIN_READY" <<'PY'
import json
import sys
import time
import urllib.request

base, need = sys.argv[1], int(sys.argv[2])
try:
    with urllib.request.urlopen(f"{base}/api/stats", timeout=5) as response:
        stats = json.load(response)
except Exception as error:  # noqa: BLE001 - any failure means "not ready yet"
    print(f"  control plane unreachable: {error}", file=sys.stderr)
    sys.exit(1)

now = time.time() * 1000
rows = (stats.get("cumulative") or {}).get("clients") or []
ready = [
    c for c in rows
    if now - c.get("lastSeen", 0) < 15_000
    and (c.get("downP2P", 0) + c.get("downHTTP", 0)) > 0
    and (c.get("playedSec", 0) or 0) > 3
]
stale = [
    c for c in rows
    if now - c.get("lastSeen", 0) < 15_000
    and (c.get("downP2P", 0) + c.get("downHTTP", 0)) == 0
]
print(f"  ready {len(ready)}/{need}" + (f", silent-but-live {len(stale)}" if stale else ""),
      file=sys.stderr)
sys.exit(0 if len(ready) >= need else 1)
PY
  then
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "not enough ready peers." >&2
    echo "" >&2
    echo "Peers that report playback progress but zero bytes are serving the media" >&2
    echo "from the browser's HTTP cache: the request never leaves the browser, so" >&2
    echo "neither the P2P engine nor the origin sees it. A normal reload keeps using" >&2
    echo "those entries — each device needs a HARD reload:" >&2
    echo "  mobile: close the tab and reopen the URL" >&2
    echo "  desktop: Ctrl+Shift+R" >&2
    echo "Also close any page opened on the server machine itself (its address is one" >&2
    echo "of this host's own IPs): that traffic is local delivery, not a real device." >&2
    exit 1
  fi
  sleep 5
done
