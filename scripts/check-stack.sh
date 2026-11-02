#!/usr/bin/env bash
# Static + connectivity assertions. Exit 0 only when every check passes.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
STUN_PORT="${STUN_PORT:-3478}"
BASE="http://127.0.0.1:$PORT"
fail=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fail=1; }

echo "checking $BASE"

# --- player page
if code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" && [[ "$code" == 200 ]]; then
  pass "landing page 200"
else
  fail "player page (got $code)"
fi

# The portal renders its cards client-side, so the check asserts the feed
# container is in the shell rather than the cards themselves.
if curl -s "$BASE/" | grep -q 'id="feedGrid"'; then
  pass "landing page lists rooms"
else
  fail "landing page missing room list"
fi

# /r/<id> is served from the same shell for every room, so a valid id proves the
# route rewrite works without creating state.
if curl -s "$BASE/r/aaaaaaaa" | grep -q 'id="video"'; then
  pass "room page served with video element"
else
  fail "room page missing video element"
fi

if python3 - "$BASE" <<'PY2'
import json, sys, urllib.request
with urllib.request.urlopen(f"{sys.argv[1]}/api/rooms", timeout=5) as response:
    payload = json.load(response)
assert isinstance(payload.get("rooms"), list), payload
assert "freeBytes" in payload.get("disk", {}), payload
PY2
then
  pass "/api/rooms lists rooms and disk"
else
  fail "/api/rooms invalid"
fi

if code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/player.js")" && [[ "$code" == 200 ]]; then
  pass "player bundle 200"
else
  fail "player bundle (got $code)"
fi

# --- playlist (sample asset; absent once the sample is replaced by real rooms)
PLAYLIST="$(curl -s "$BASE/hls/stream/index.m3u8")"
if grep -q '^#EXTM3U' <<<"$PLAYLIST"; then
  pass "manifest 200 and well-formed"
else
  fail "manifest missing or malformed"
fi

SEGMENT="$(grep -m1 '\.ts$' <<<"$PLAYLIST" || true)"
if [[ -z "$SEGMENT" ]]; then
  fail "manifest lists no .ts segment"
else
  headers="$(curl -s -D - -o /dev/null -H 'Range: bytes=0-1' "$BASE/hls/stream/$SEGMENT")"
  status="$(head -1 <<<"$headers" | awk '{print $2}')"
  if [[ "$status" == 206 ]]; then
    pass "segment $SEGMENT honours Range (206)"
  else
    fail "segment $SEGMENT Range request (got $status)"
  fi
  ctype="$(grep -i '^content-type:' <<<"$headers" | tr -d '\r' | awk '{print $2}')"
  case "$ctype" in
    video/mp2t|application/octet-stream) pass "segment content-type $ctype" ;;
    *) fail "segment content-type (got '$ctype')" ;;
  esac
fi

# --- control API
if python3 - "$BASE" <<'PY'
import json, sys, urllib.request
base = sys.argv[1]
with urllib.request.urlopen(f"{base}/api/health", timeout=5) as r:
    health = json.load(r)
assert health.get("ok") is True, health
with urllib.request.urlopen(f"{base}/api/stats", timeout=5) as r:
    stats = json.load(r)
assert "window" in stats and "cumulative" in stats, stats
assert "p2pRatio" in stats["window"], stats["window"]
assert isinstance(health.get("stun", {}).get("requests"), int), health
PY
then
  pass "/api/health + /api/stats valid JSON"
else
  fail "/api/health or /api/stats invalid"
fi

# --- tracker websocket handshake (real WebSocket, not a plain GET)
if node --input-type=module - "$PORT" <<'JS'
const port = process.argv[2];
const outcome = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tracker`);
  const timer = setTimeout(() => resolve(`timeout, readyState=${ws.readyState}`), 5000);
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    ws.close();
    resolve("open");
  });
  ws.addEventListener("error", (event) => {
    clearTimeout(timer);
    resolve(`error ${event?.message ?? ""}`);
  });
});
if (outcome !== "open") {
  console.error(outcome);
  process.exit(1);
}
JS
then
  pass "tracker websocket handshake"
else
  fail "tracker websocket handshake"
fi

# --- STUN binding (RFC 5389). Load-bearing: Chrome hides host candidates behind
# mDNS, so across HITSZ subnets the server-reflexive candidate this returns is
# the only way two viewers can connect. Assert it echoes the real source port.
if node - "$STUN_PORT" <<'JS'
const dgram = require("node:dgram");
const crypto = require("node:crypto");
const COOKIE = 0x2112a442;
const port = Number(process.argv[2]);

const txid = crypto.randomBytes(12);
const request = Buffer.alloc(20);
request.writeUInt16BE(0x0001, 0);
request.writeUInt32BE(COOKIE, 4);
txid.copy(request, 8);

const socket = dgram.createSocket("udp4");
const done = (ok, detail) => {
  socket.close();
  if (!ok) console.error(detail);
  process.exit(ok ? 0 : 1);
};
const timer = setTimeout(() => done(false, "timeout waiting for binding response"), 3000);

socket.on("message", (msg) => {
  clearTimeout(timer);
  if (msg.readUInt16BE(0) !== 0x0101) return done(false, "not a binding success");
  if (msg.readUInt32BE(4) !== COOKIE) return done(false, "magic cookie mismatch");
  if (!msg.subarray(8, 20).equals(txid)) return done(false, "transaction id not echoed");

  const expectedPort = socket.address().port;
  let off = 20;
  const length = msg.readUInt16BE(2);
  while (off < 20 + length) {
    const type = msg.readUInt16BE(off);
    const attrLen = msg.readUInt16BE(off + 2);
    if (type === 0x0020) {
      const echoed = msg.readUInt16BE(off + 6) ^ 0x2112;
      if (echoed !== expectedPort) return done(false, `xor-mapped port ${echoed} != ${expectedPort}`);
      return done(true);
    }
    off += 4 + attrLen + ((4 - (attrLen % 4)) % 4);
  }
  done(false, "no XOR-MAPPED-ADDRESS in response");
});

socket.bind(0, "127.0.0.1", () => socket.send(request, port, "127.0.0.1"));
JS
then
  pass "stun binding echoes source address"
else
  fail "stun binding"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "check-stack: FAILED" >&2
  exit 1
fi
echo "check-stack: OK"
