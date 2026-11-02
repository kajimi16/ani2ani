#!/usr/bin/env bash
# Launch N independent headless Chrome viewers with isolated profiles.
#
# Separate processes, not tabs: a shared browser shares its HTTP cache (one
# viewer's segment fetch would silently serve the others, poisoning the P2P
# measurement) and only one tab is ever foregrounded. One process per viewer is
# the closest local approximation of one device per viewer.
#
#   bash scripts/local-viewers.sh start [n] [base_url] [lead_count]
#   bash scripts/local-viewers.sh stop
#
# lead_count forces the lead/follow split for a controlled comparison: that many
# viewers get ?role=lead, the rest ?role=follow. Omit it to let each viewer pick
# its role from its peer id, as real deployments do.
set -euo pipefail
cd "$(dirname "$0")/.."

ACTION="${1:?usage: local-viewers.sh start|stop [n] [base_url]}"
COUNT="${2:-3}"
BASE_URL="${3:-http://127.0.0.1:8080/}"
LEAD_COUNT="${4:-}"
PROFILE_ROOT="run/viewers"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"

stop_all() {
  for pidfile in "$PROFILE_ROOT"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
}

case "$ACTION" in
  start)
    [[ -n "$CHROME" ]] || { echo "no chrome binary found; set CHROME=" >&2; exit 1; }
    mkdir -p "$PROFILE_ROOT"
    stop_all
    for i in $(seq 1 "$COUNT"); do
      profile="$PROFILE_ROOT/v$i"
      rm -rf "$profile"
      mkdir -p "$profile"
      url="$BASE_URL"
      if [[ -n "$LEAD_COUNT" ]]; then
        sep="?"
        [[ "$url" == *"?"* ]] && sep="&"
        if [[ "$i" -le "$LEAD_COUNT" ]]; then url="${url}${sep}role=lead"; else url="${url}${sep}role=follow"; fi
      fi
      nohup "$CHROME" \
        --headless=new \
        --disable-gpu \
        --no-first-run \
        --no-default-browser-check \
        --mute-audio \
        --autoplay-policy=no-user-gesture-required \
        --disable-background-timer-throttling \
        --disable-backgrounding-occluded-windows \
        --disable-renderer-backgrounding \
        --disable-features=CalculateNativeWinOcclusion \
        --user-data-dir="$PWD/$profile" \
        --window-size=960,600 \
        --remote-debugging-port=$((9230 + i)) \
        "$url" >"$profile/chrome.log" 2>&1 &
      echo $! >"$PROFILE_ROOT/v$i.pid"
      echo "viewer $i started (pid $!, role $( [[ -n "$LEAD_COUNT" ]] && { [[ "$i" -le "$LEAD_COUNT" ]] && echo lead || echo follow; } || echo auto ))"
    done
    ;;
  stop)
    stop_all
    echo "viewers stopped"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 1
    ;;
esac
