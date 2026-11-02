#!/usr/bin/env bash
# Judge one round. Exit 0 = pass, 1 = fail, 2 = unusable measurement.
#
# The P2P ceiling is physics, not tuning: in synchronized playback every segment
# must be pulled from the origin by *someone*, so the server carries at least
# 1/N of the bytes and the ceiling is (N-1)/N. A fixed 70% target is therefore
# unreachable at N=3 (66.7%), so the bar is 0.85 of that ceiling — "near-optimal
# for this N", measurable at any device count.
set -uo pipefail
cd "$(dirname "$0")/.."

DIR="${1:?usage: verify-round.sh rounds/<label>}"
SUMMARY="$DIR/summary.json"
[[ -f "$SUMMARY" ]] || { echo "missing $SUMMARY" >&2; exit 2; }

# Every IPv4 address belonging to this host. A browser on the host reaching the
# campus address still goes through local delivery — no radio, no AP, no campus
# backbone — so such a peer must not be counted as a real device. Enumerated from
# the live interface list rather than assumed, because the campus address changes
# with DHCP and tunnels/bridges add more.
HOST_ADDRS="$(ip -4 -o addr show 2>/dev/null \
  | awk '{for (i = 1; i <= NF; i++) if ($i == "inet") print $(i + 1)}' \
  | cut -d/ -f1 | tr '\n' ' ')"

python3 - "$DIR" "$HOST_ADDRS" <<'PY'
import datetime
import json
import sys
from pathlib import Path

directory = Path(sys.argv[1])
HOST_ADDRS = set((sys.argv[2] if len(sys.argv) > 2 else "").split())
summary = json.loads((directory / "summary.json").read_text())
steady = summary["steady"]

from_ms = datetime.datetime.fromisoformat(steady["from"].replace("Z", "+00:00")).timestamp() * 1000
to_ms = datetime.datetime.fromisoformat(steady["to"].replace("Z", "+00:00")).timestamp() * 1000

# Membership: a client counts only if it was still reporting at the end of the
# window. Clients that left mid-window would inflate N (and therefore the
# ceiling) while contributing bytes from only part of it.
REPORT_LULL_MS = 15_000


def participated(c):
    """Membership for the (N-1)/N ceiling.

    Two conditions, both load-bearing:
    - present at window end (a client that left mid-window would contribute
      partial bytes while still inflating N);
    - actually fetched bytes in the window. A tab left open but paused/backgrounded
      still reports, contributes nothing, and would otherwise raise N — inflating
      the ceiling and making an idle viewer look like swarm capacity it is not.
    A client that fetched nothing forced no origin traffic, so it is not a peer.
    """
    if c.get("samples", 0) < 2:
        return False
    last = c.get("lastSampleAt")
    if last is not None and last < to_ms - REPORT_LULL_MS:
        return False
    return (c.get("downP2P", 0) + c.get("downHTTP", 0)) > 0


all_clients = steady.get("clients", [])
clients = [c for c in all_clients if participated(c)]
idle = len(all_clients) - len(clients)

CEILING_FRACTION = 0.85
DEVIATION_LIMIT = 0.10
MIN_CLIENTS = 3
# A single peer holding more than this multiple of its fair share of origin
# segments means the engine stopped spreading origin fetches, which is the only
# situation where a designated lead helps rather than hurts. Measured: balanced
# swarm 1.45x, designated lead 4.50x.
CONCENTRATION_LIMIT = 2.0

n = len(clients)
p2p = sum(int(c.get("downP2P", 0)) for c in clients)
http = sum(int(c.get("downHTTP", 0)) for c in clients)
ratio = p2p / (p2p + http) if (p2p + http) else 0.0
ceiling = (n - 1) / n if n else 0.0
required = CEILING_FRACTION * ceiling

# (window bounds are computed above, before membership filtering)

def log_timestamp_ms(value):
    """Caddy writes float epoch seconds by default; accept ISO strings too."""
    if isinstance(value, (int, float)):
        return value * 1000.0
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return None
    return None


server_http = 0
largest_segment = 0
access = directory / "access.log"
if access.exists():
    for line in access.read_text().splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        uri = (entry.get("request") or {}).get("uri", "")
        if not uri.startswith("/hls/") or uri.endswith(".m3u8"):
            continue
        ts = log_timestamp_ms(entry.get("ts"))
        if ts is None or not (from_ms <= ts <= to_ms):
            continue
        size = int(entry.get("size") or entry.get("bytes_written") or 0)
        server_http += size
        largest_segment = max(largest_segment, size)

# Players sample once a second, the server logs by completion time. The baseline
# sample can therefore predate a segment that completed just after the window
# opened, so one segment of slop is inherent — not a broken instrument. At low
# traffic that single segment is a large *fraction*, so the tolerance is
# whichever is bigger: the percentage limit or one segment.
denom = max(server_http, http)
deviation = abs(server_http - http) / denom if denom else 0.0
slop_allowed = largest_segment / denom if denom else 0.0
deviation_limit = max(DEVIATION_LIMIT, slop_allowed)

print(f"round            {summary['label']}")
print(f"steady window    {steady['from']} .. {steady['to']}")
# Origin-request spread: the decisive number for whether a designated lead is
# warranted. The engine's demand window normally spreads origin fetches across
# the swarm (measured max 1.45x fair share at N=6). A designated lead instead
# concentrates them (measured 4.50x fair, one machine carrying 75% of origin
# segments), which loads a single uplink — a loss on WiFi unless the spread was
# degenerate to begin with.
seeds = sum(int(c.get("lead", 0)) for c in clients)
origin_segments = [int(c.get("segmentsHTTP", 0)) for c in clients]
total_origin = sum(origin_segments)
fair_share = total_origin / n if n else 0.0
worst_share = max(origin_segments) if origin_segments else 0
concentration = worst_share / fair_share if fair_share else 0.0

def addr_class(addr):
    """Classify a reporting peer's origin.

    Historical rounds lack the field entirely; report that as unrecorded rather
    than guessing, since guessing either way misrepresents the evidence.
    A host-owned address (including the campus IP this server binds) is still
    local traffic: the browser runs on the same machine, so no wireless or campus
    path is exercised and its P2P share is optimistic.
    """
    if addr in (None, "", "unknown"):
        return "unrecorded"
    addr = str(addr)
    if addr in ("::1", "localhost"):
        return "local"
    if addr.startswith("127.") or addr.startswith("::ffff:127."):
        return "local"
    if "%" in addr:  # IPv6 zone id, e.g. fe80::1%enp7s0
        addr = addr.split("%", 1)[0]
    if addr == "::1" or addr.startswith("fe80:"):
        return "local"
    if addr.startswith("::ffff:"):
        addr = addr[len("::ffff:"):]
    return "local" if addr in HOST_ADDRS else "network"


classes = {"local": 0, "network": 0, "unrecorded": 0}
addrs = {}
for c in clients:
    cls = addr_class(c.get("addr"))
    classes[cls] += 1
    key = c.get("addr") or "unknown"
    addrs[key] = addrs.get(key, 0) + 1

print(f"active clients N {n}  (designated leads {seeds}, idle/ignored {idle})")
if addrs:
    detail = ", ".join(f"{a}×{k}" for a, k in sorted(addrs.items()))
    print(f"origins          {detail}")
    if classes["unrecorded"]:
        print("evidence         unrecorded origin — cannot claim real-device coverage")
    elif classes["local"] and classes["network"]:
        print(f"evidence         MIXED ({classes['local']} local / {classes['network']} network) — "
              "local peers have no radio bottleneck, so their share is optimistic; "
              "do not cite as real-device evidence")
    elif classes["local"]:
        print("evidence         all-local — no wireless or campus path exercised; "
              "not real-device evidence")
    else:
        print(f"evidence         network-only ({classes['network']} peers) — usable as "
              "real-device evidence")
print(f"player bytes     p2p {p2p / 1e6:.2f} MB / http {http / 1e6:.2f} MB")
print(f"p2p ratio        {ratio * 100:.1f}%")
print(f"ceiling (N-1)/N  {ceiling * 100:.1f}%")
print(f"required         {required * 100:.1f}%  (0.85 x ceiling)")
print(f"server http      {server_http / 1e6:.2f} MB (Caddy log size field)")
print(f"dual-source dev  {deviation * 100:.1f}%  "
      f"(limit {deviation_limit * 100:.0f}% = max({DEVIATION_LIMIT * 100:.0f}%, "
      f"one {largest_segment / 1e6:.1f} MB segment))")

# Playback progress. Uses the player's monotonic `playedSec`, not `videoTime`:
# the shared playback clock loops the asset, so `videoTime` resets every lap and
# a naive max() would report "advanced 2s" for a perfectly healthy screening.
# A round where nothing actually decoded is prefetch-only traffic; its byte
# ratios look healthy and mean nothing, so it must not be scored.
samples_path = directory / "samples.jsonl"
progress = []
if samples_path.exists():
    for line in samples_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            sample = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows = ((sample.get("stats") or {}).get("window") or {}).get("clients") or []
        if not rows:
            continue
        played = [float(r.get("playedSec", 0)) for r in rows]
        # Legacy rounds predate playedSec; they also predate the looping clock,
        # so videoTime is monotonic there and is the correct fallback.
        value = max(played) if any(played) else max(float(r.get("videoTime", 0)) for r in rows)
        progress.append((sample.get("polledAt"), value, any(played)))

advanced = 0.0
elapsed = 0.0
if len(progress) >= 2:
    (t_first, v_first, _), (t_last, v_last, has_played) = progress[0], progress[-1]
    elapsed = (t_last - t_first) / 1000.0
    advanced = v_last - v_first
    progress_ratio = advanced / elapsed if elapsed > 0 else 0.0
    label = "played          " if has_played else "playhead (legacy)"
    print(f"{label} +{advanced:.0f}s over {elapsed:.0f}s wall  "
          f"({progress_ratio * 100:.0f}% of realtime)")

# Concentration is a statistic over origin requests: with a handful of segments it
# is noise (4 segments across 3 peers reads as 2.25x without meaning anything).
# Require a real sample before drawing a conclusion from it.
MIN_ORIGIN_SEGMENTS = 20
if total_origin and total_origin < MIN_ORIGIN_SEGMENTS:
    print(f"origin spread    only {total_origin} origin segment(s) — too few to judge "
          f"concentration (need >= {MIN_ORIGIN_SEGMENTS})")
elif total_origin:
    spread_note = (
        "balanced — engine already spreads origin fetches; a designated lead would "
        "concentrate them and load one uplink"
        if concentration <= CONCENTRATION_LIMIT
        else "concentrated — one peer carries the origin traffic; designating a wired "
             "strong-uplink machine as ?role=lead is then preferable"
    )
    print(f"origin spread    worst {worst_share}/{total_origin} = {concentration:.2f}x fair "
          f"(limit {CONCENTRATION_LIMIT}x) — {spread_note}")

# Per-address reconciliation. The aggregate deviation can hide two opposite
# errors cancelling out (cache hits counted as HTTP, aborted-and-retried requests
# counted twice by the server). Comparing each peer's claimed HTTP bytes with what
# the origin actually logged for its address exposes both.
per_addr_server = {}
if access.exists():
    for line in access.read_text().splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        req = entry.get("request") or {}
        if not req.get("uri", "").startswith("/hls/") or req.get("uri", "").endswith(".m3u8"):
            continue
        ts = log_timestamp_ms(entry.get("ts"))
        if ts is None or not (from_ms <= ts <= to_ms):
            continue
        ip = req.get("remote_ip") or "?"
        per_addr_server[ip] = per_addr_server.get(ip, 0) + int(entry.get("size") or 0)

cache_suspects = []
for c in clients:
    addr = c.get("addr")
    if addr in (None, "", "unknown"):
        continue
    claimed = int(c.get("downHTTP", 0))
    served = per_addr_server.get(addr, 0)
    if claimed > 4 << 20 and served * 4 < claimed:
        cache_suspects.append((addr, claimed, served))

if cache_suspects:
    print()
    for addr, claimed, served in cache_suspects:
        print(f"cache suspect    {addr}: player claims {claimed / 1e6:.1f} MB HTTP but the "
              f"origin logged {served / 1e6:.1f} MB")
    print("                 warm browser cache serves segments without reaching Caddy, while the "
          "P2P engine still counts them as HTTP — re-run with a cache-busted round")

unusable = []
problems = []

if cache_suspects:
    unusable.append(
        f"{len(cache_suspects)} peer(s) report origin traffic the origin never served "
        f"(warm cache) — origin accounting cannot be trusted")

if n < MIN_CLIENTS:
    unusable.append(f"only {n} client(s) reporting in the window; need >= {MIN_CLIENTS}")
if (p2p + http) == 0:
    unusable.append("no player byte counters in window")
if server_http == 0 and p2p > 0:
    # The (N-1)/N ceiling assumes every segment is pulled from the origin at least
    # once inside the window. With zero origin traffic that premise is void: the
    # swarm pre-populated its cache before the window (typical on loopback, where
    # the whole asset downloads in seconds), so "100% P2P" measures nothing.
    unusable.append(
        "zero origin bytes inside the window: the swarm had already cached the "
        "asset, so there was no origin demand to offload (restart clients at round "
        "start, or measure over a real network)")
if deviation > deviation_limit:
    unusable.append(
        f"player and server byte counts disagree by {deviation * 100:.1f}% "
        f"(limit {deviation_limit * 100:.0f}%)")
if len(progress) >= 2 and advanced < 0.5 * elapsed:
    unusable.append(
        f"only {advanced:.0f}s decoded in {elapsed:.0f}s of wall clock: "
        f"this round measured prefetch, not playback")


if not unusable:
    if p2p == 0:
        problems.append("zero P2P bytes: peers never served each other")
    if ratio < required:
        problems.append(f"ratio {ratio * 100:.1f}% below required {required * 100:.1f}%")

if unusable:
    print("\nUNUSABLE MEASUREMENT (does not consume a tuning round):")
    for item in unusable:
        print(f"  - {item}")
    sys.exit(2)

if problems:
    print("\nFAIL:")
    for item in problems:
        print(f"  - {item}")
    sys.exit(1)

print("\nPASS")
sys.exit(0)
PY
