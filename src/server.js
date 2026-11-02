// Screening control plane: rooms, WebTorrent tracker (WS), stats ingest, STUN.
//
// Deliberately does NOT serve media. Caddy front-ends :8080, serves the HLS
// trees, and owns the HTTP egress accounting via its JSON access log; that log
// is the independent second opinion used to trust (or reject) the in-browser
// P2P numbers.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { startStun } from "./stun.js";
import Tracker from "bittorrent-tracker/server";
import {
  canAccept,
  createRoom,
  discardOutput,
  estimatedFootprint,
  diskInfo,
  getRoom,
  hasAccessToken,
  hlsDir,
  isPrivate,
  issueAccessToken,
  listRooms,
  load as loadRooms,
  markStarted,
  noteHostPosition,
  posterPath,
  removeRoom,
  save as saveRooms,
  setHost,
  sourcePath,
  updateRoom,
  verifyRoomPassword,
} from "./rooms.js";
import { countSegments, inspectSource, probeDuration, startTranscode } from "./transcode.js";

const API_PORT = Number(process.env.API_PORT ?? 8001);
const STUN_PORT = Number(process.env.STUN_PORT ?? 3478);
const SAMPLE_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = Number(process.env.ROOM_MAX_UPLOAD_MB ?? 8192) * 1024 * 1024;
// Concurrency cap for ffmpeg. Transcoding is CPU-bound and competes directly with
// the node process that also serves tracking and stats for screens already live,
// so an unbounded fleet of jobs would starve playback. Two at a time on this
// machine leaves headroom; the rest wait in a visible queue.
const TRANSCODE_CONCURRENCY = Number(process.env.ROOM_TRANSCODE_CONCURRENCY ?? 2);
// Room budget. Rooms are the unit of disk consumption, so the count cap and the
// per-upload cap together bound worst-case occupancy.
const MAX_ROOMS = Number(process.env.ROOM_MAX_COUNT ?? 20);
// Room creation is the cheapest way to consume disk, so it is rate limited per
// origin rather than only counted.
const ROOM_CREATE_WINDOW_MS = 60 * 60 * 1000;
const ROOM_CREATE_LIMIT = Number(process.env.ROOM_CREATE_LIMIT ?? 6);
// The uploaded source is dead weight once transcoding succeeds: measured on a
// 900 s 720p file it was 296 MB against 308 MB of segments, so keeping it nearly
// halves the storage available for screens. Kept only when explicitly asked.
const KEEP_SOURCE = process.env.ROOM_KEEP_SOURCE === "1";
const DEFAULT_ROOM_ID = "default";
/* ------------------------------------------------------- space & retention */

// Two thresholds, deliberately different:
//   - normally a room nobody has touched for 48 h is deleted;
//   - when the volume drops under 20 GB free, 6 h of silence is enough.
// The low-disk rule is what keeps the machine from filling up during a run of
// screenings, and it is the reason the portal never needs to show a byte count.
const ROOM_IDLE_HOURS = positive(process.env.ROOM_IDLE_HOURS, 48);
const ROOM_LOW_DISK_IDLE_HOURS = positive(process.env.ROOM_LOW_DISK_IDLE_HOURS, 6);
const ROOM_LOW_DISK_GB = positive(process.env.ROOM_LOW_DISK_GB, 20);

function positive(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isLowDisk() {
  return diskInfo().freeBytes < ROOM_LOW_DISK_GB * 1e9;
}

/** When this room last had any sign of life: creation, playback, or a peer. */
function roomLastActive(room, now) {
  let last = Math.max(room.createdAt ?? 0, room.startedAt ?? 0, room.endedAt ?? 0, room.hostRef?.at ?? 0);
  for (const entry of clients.values()) {
    if (entry.roomId === room.id) last = Math.max(last, entry.lastSeen);
  }
  return last;
}

/**
 * Delete rooms nobody is using.
 *
 * Never while an upload or transcode is in flight, and never while somebody is
 * connected: losing a job halfway through, or kicking a viewer out to reclaim
 * space, is worse than waiting for the next sweep. Called on a timer and once
 * at startup, so a restart also reconciles a disk that filled while down.
 */
function sweepIdleRooms(now = Date.now()) {
  const lowDisk = isLowDisk();
  const graceMs = (lowDisk ? ROOM_LOW_DISK_IDLE_HOURS : ROOM_IDLE_HOURS) * 3600 * 1000;
  let removed = 0;

  for (const view of listRooms()) {
    const room = getRoom(view.id);
    if (!room) continue;
    if (busyRooms.has(room.id) || transcodeJobs.has(room.id)) continue;

    const watching = [...clients.values()].some(
      (entry) => entry.roomId === room.id && now - entry.lastSeen < LIVE_WINDOW_MS,
    );
    if (watching) continue;
    if (now - roomLastActive(room, now) <= graceMs) continue;

    transcodeJobs.get(room.id)?.kill();
    transcodeJobs.delete(room.id);
    removeRoom(room.id);
    removed += 1;
  }

  if (removed > 0) {
    log(`retention: removed ${removed} room(s) idle > ${graceMs / 3600000} h${lowDisk ? " (low disk)" : ""}`);
  }
  return removed;
}

const LIVE_WINDOW_MS = 15_000;
// Deliberately longer than LIVE_WINDOW_MS. A follower going quiet for a moment is
// noise; a host going quiet means the screening has no leader, and taking the room
// away from someone whose phone merely locked is worse than waiting.
const HOST_TIMEOUT_MS = Number(process.env.ROOM_HOST_TIMEOUT_S ?? 30) * 1000;

const log = (message) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);

/* ---------------------------------------------------------------- tracker */

const tracker = new Tracker({
  http: false,
  udp: false,
  stats: false,
  ws: { noServer: true },
  interval: 30_000,
});

function swarmStats() {
  const swarms = [];
  for (const [infoHash, swarm] of Object.entries(tracker.torrents)) {
    const peerIds = swarm.peers.keys ?? [];
    swarms.push({
      infoHash,
      peers: peerIds.length,
      complete: swarm.complete ?? 0,
      incomplete: swarm.incomplete ?? 0,
    });
  }
  return swarms;
}

/* ----------------------------------------------------------------- danmaku */

// A room's comments: broadcast to everyone in it, and kept in a short backlog so
// a late joiner still sees the conversation in the sidebar. In memory only — a
// screening's chatter is not worth persisting, and a restart clearing it is fine.
const DANMAKU_BACKLOG = 200;
const DANMAKU_MAX_LEN = 120;
/** @type {Map<string, {history: Array<object>, sockets: Set<object>}>} */
const danmakuRooms = new Map();

const danmakuWss = new WebSocketServer({ noServer: true, clientTracking: false });

function danmakuRoom(roomId) {
  let entry = danmakuRooms.get(roomId);
  if (!entry) {
    entry = { history: [], sockets: new Set() };
    danmakuRooms.set(roomId, entry);
  }
  return entry;
}

function broadcastRoom(roomId, payload) {
  const entry = danmakuRoom(roomId);
  const wire = JSON.stringify(payload);
  for (const socket of entry.sockets) {
    if (socket.readyState === 1) socket.send(wire);
  }
}

function broadcastDanmaku(roomId, payload) {
  const entry = danmakuRoom(roomId);
  entry.history.push(payload);
  if (entry.history.length > DANMAKU_BACKLOG) entry.history.shift();
  broadcastRoom(roomId, { type: "danmaku", item: payload });
}

danmakuWss.on("connection", (socket, req, roomId) => {
  const room = getRoom(roomId);
  if (!room) {
    socket.close(4004, "room not found");
    return;
  }
  const entry = danmakuRoom(roomId);
  entry.sockets.add(socket);

  socket.send(JSON.stringify({ type: "history", items: entry.history }));
  socket.send(JSON.stringify({ type: "welcome", roomId }));

  socket.on("message", (raw) => {
    if (raw.length > 2048) return;
    let body;
    try {
      body = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (body?.type !== "danmaku") return;
    const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, DANMAKU_MAX_LEN);
    if (!text) return;

    broadcastDanmaku(roomId, {
      id: crypto.randomUUID(),
      peerId: typeof body.peerId === "string" ? body.peerId.slice(0, 40) : "?",
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 24) : null,
      text,
      // Anchored to the sender's playhead so a replay can place it correctly.
      videoTime: Number(body.videoTime) || 0,
      at: Date.now(),
    });
  });

  socket.on("close", () => entry.sockets.delete(socket));
  socket.on("error", () => entry.sockets.delete(socket));
});

/* ------------------------------------------------------------ stats ingest */

/**
 * Samples are keyed by room + peer, because the same browser can watch two
 * different rooms in two tabs and those are separate participants with separate
 * statistics.
 */
const clients = new Map();
let roundStartedAt = Date.now();
let roundLabel = "unlabelled";
// Shared playback clock for the legacy single-stream room. Real rooms carry their
// own epoch on the room record.
let syncEpochMs = Date.now();

const COUNTER_FIELDS = ["downP2P", "downHTTP", "upP2P", "segmentsP2P", "segmentsHTTP", "playedSec"];
const GAUGE_FIELDS = ["peers", "lead", "videoTime", "buffered", "syncDrift"];
const NUMBER_FIELDS = [...COUNTER_FIELDS, ...GAUGE_FIELDS];

/**
 * Origin address of a report. Caddy front-ends every request, so the socket peer
 * is always the proxy; the real origin is in X-Forwarded-For.
 * Recorded so a round can prove which of its peers were loopback simulations and
 * which were real devices — a mixed round must never be cited as real-device
 * evidence.
 */
function originAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function clientKey(roomId, peerId) {
  return `${roomId}:${peerId}`;
}

function recordSample(roomId, peerId, sample, addr) {
  const now = Date.now();
  const key = clientKey(roomId, peerId);
  let entry = clients.get(key);
  if (!entry) {
    entry = { key, roomId, peerId, addr: addr ?? "unknown", lastSeen: now, samples: [] };
    clients.set(key, entry);
  } else if (addr) {
    entry.addr = addr;
  }
  entry.lastSeen = now;
  // Presentation state, not measurement: who this is and where their playhead is.
  if (typeof sample.name === "string" && sample.name.trim()) {
    entry.name = sample.name.trim().slice(0, 24);
  }
  // Stable across reloads; peerId is regenerated by the P2P engine on every load,
  // which is what made one person show up as several in the participant list.
  if (typeof sample.viewerId === "string" && sample.viewerId.trim()) {
    entry.viewerId = sample.viewerId.trim().slice(0, 40);
  }
  entry.videoTime = Number(sample.videoTime) || 0;
  entry.playing = Boolean(sample.playing);

  // The host's own reports are what everyone else tracks.
  const room = getRoom(roomId);
  if (room && room.hostPeerId === peerId) {
    noteHostPosition(room, entry.videoTime, entry.playing);
  }

  const s = {};
  for (const field of NUMBER_FIELDS) {
    const value = Number(sample[field]);
    s[field] = Number.isFinite(value) ? value : 0;
  }
  entry.samples.push({ at: now, s });

  const cutoff = now - SAMPLE_TTL_MS;
  while (entry.samples.length > 0 && entry.samples[0].at < cutoff) entry.samples.shift();
}

function countersAt(entry, at) {
  let chosen;
  for (const sample of entry.samples) {
    if (sample.at <= at) chosen = sample;
    else break;
  }
  return chosen?.s ?? entry.samples[0]?.s;
}

function delta(entry, fromMs, toMs) {
  const a = countersAt(entry, fromMs);
  const b = countersAt(entry, toMs);
  if (!a || !b) return null;
  const out = {};
  for (const field of COUNTER_FIELDS) out[field] = Math.max(0, (b[field] ?? 0) - (a[field] ?? 0));
  for (const field of GAUGE_FIELDS) out[field] = b[field] ?? 0;
  return out;
}

function windowReport(fromMs, toMs, roomId) {
  const perClient = [];
  const total = Object.fromEntries(NUMBER_FIELDS.map((f) => [f, 0]));

  for (const entry of clients.values()) {
    if (roomId && entry.roomId !== roomId) continue;
    const d = delta(entry, fromMs, toMs);
    if (!d) continue;
    perClient.push({
      peerId: entry.peerId,
      roomId: entry.roomId,
      addr: entry.addr ?? "unknown",
      lastSeen: entry.lastSeen,
      samples: entry.samples.length,
      lastSampleAt: entry.samples.at(-1)?.at ?? null,
      ...d,
    });
    for (const field of NUMBER_FIELDS) total[field] += d[field];
  }

  const downAll = total.downP2P + total.downHTTP;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    clients: perClient,
    total,
    p2pRatio: downAll > 0 ? total.downP2P / downAll : 0,
  };
}

/**
 * Who is in the room right now, in a stable order.
 *
 * Sorted by join order (first sample time) so the list does not reshuffle while
 * people watch; the host is marked rather than hoisted, because a list that
 * reorders when the host changes is disorienting mid-screening.
 */
/**
 * Who is in the room, one row per person.
 *
 * A reload creates a new peerId (the P2P engine makes one per page load), so the
 * old session lingers for LIVE_WINDOW_MS and the same person appeared twice.
 * The browser keeps a stable `viewerId`; entries are grouped by it (falling back
 * to peerId for clients that do not send one) and the freshest session wins.
 */
function participants(roomId, hostPeerId) {
  const now = Date.now();
  const groups = new Map();

  for (const entry of clients.values()) {
    if (entry.roomId !== roomId) continue;
    if (now - entry.lastSeen >= LIVE_WINDOW_MS) continue;
    const key = entry.viewerId || `peer:${entry.peerId}`;
    const firstSeen = entry.samples[0]?.at ?? entry.lastSeen;
    const isHost = entry.peerId === hostPeerId;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { entry, isHost, firstSeen });
      continue;
    }
    group.isHost = group.isHost || isHost;
    group.firstSeen = Math.min(group.firstSeen, firstSeen);
    if (entry.lastSeen >= group.entry.lastSeen) group.entry = entry;
  }

  return [...groups.values()]
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map(({ entry, isHost }) => ({
      peerId: entry.peerId,
      viewerId: entry.viewerId ?? null,
      name: entry.name ?? null,
      isHost,
      videoTime: entry.videoTime ?? 0,
      playing: Boolean(entry.playing),
      lastSeen: entry.lastSeen,
    }));
}

/** Is the recorded host no longer reporting? A crashed host looks like this. */
function hostIsAway(room) {
  if (!room?.hostPeerId) return false;
  const now = Date.now();
  const host = [...clients.values()].find(
    (entry) => entry.roomId === room.id && entry.peerId === room.hostPeerId,
  );
  return !host || now - host.lastSeen > HOST_TIMEOUT_MS;
}

function liveViewers(roomId) {
  const now = Date.now();
  return [...clients.values()].filter(
    (entry) => entry.roomId === roomId && now - entry.lastSeen < LIVE_WINDOW_MS,
  ).length;
}

function health(roomId = DEFAULT_ROOM_ID) {
  const swarms = swarmStats();
  const liveClients = [...clients.values()].filter((c) => Date.now() - c.lastSeen < LIVE_WINDOW_MS);
  const room = getRoom(roomId);
  return {
    ok: true,
    round: { label: roundLabel, startedAt: new Date(roundStartedAt).toISOString() },
    sync: {
      epochMs: room?.syncEpochMs ?? syncEpochMs,
      at: new Date(room?.syncEpochMs ?? syncEpochMs).toISOString(),
      serverNowMs: Date.now(),
    },
    uptimeSec: Math.round(process.uptime()),
    clientsTotal: clients.size,
    clientsLive: liveClients.length,
    swarms,
    stun: stun.stats(),
    disk: diskInfo(),
  };
}

/* ------------------------------------------------------------------- http */

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (body.length === 0) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/* ------------------------------------------------------------------ rooms */

/** Media for a room, as the browser will request it. */
function roomMediaBase(room) {
  return `/media/${room.id}/hls/`;
}

/* ------------------------------------------------------------ host voting */

// A room whose host walked away needs a way to pick a new one that is not "the
// first person to grab the seat". Everyone in the room votes; three quarters
// must agree, rounded down, and silence counts as disagreement.
const VOTE_DURATION_MS = 30_000;
const VOTE_APPROVAL_RATIO = 0.75;
const voteTimers = new Map();

function publicVote(vote) {
  if (!vote) return null;
  const ballots = Object.values(vote.ballots ?? {});
  return {
    id: vote.id,
    candidateName: vote.candidateName,
    startedAt: vote.startedAt,
    endsAt: vote.endsAt,
    total: vote.eligible.length,
    approvals: ballots.filter(Boolean).length,
    rejections: ballots.filter((value) => value === false).length,
  };
}

function scheduleVote(room) {
  clearTimeout(voteTimers.get(room.id));
  const delay = Math.max(0, (room.vote?.endsAt ?? Date.now()) - Date.now());
  const timer = setTimeout(() => finishVote(room), delay);
  timer.unref?.();
  voteTimers.set(room.id, timer);
}

function finishVote(room) {
  const vote = room.vote;
  if (!vote) return null;
  clearTimeout(voteTimers.get(room.id));
  voteTimers.delete(room.id);
  room.vote = null;

  const total = vote.eligible.length;
  const approvals = Object.values(vote.ballots).filter(Boolean).length;
  const needed = Math.max(1, Math.floor(total * VOTE_APPROVAL_RATIO));
  const approved = approvals >= needed;

  if (approved) {
    // The candidate may have reloaded during the 30 s window, which gives them a
    // new peerId. Handing the room to the peerId captured at vote start would make
    // it instantly leaderless again, right after announcing that it worked.
    // Several sessions can share one viewerId (the candidate may have reloaded
    // during the vote), and the map is in insertion order — the oldest first. Take
    // the most recently active one, or the room lands on a dead peerId.
    const entry = [...clients.values()]
      .filter(
        (candidate) =>
          (candidate.viewerId || `peer:${candidate.peerId}`) === vote.candidateViewerId &&
          Date.now() - candidate.lastSeen < LIVE_WINDOW_MS,
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)[0];
    setHost(room, entry?.peerId ?? vote.candidatePeerId, vote.candidateName);
    if (entry) noteHostPosition(room, entry.videoTime ?? 0, Boolean(entry.playing));
  }

  const result = {
    id: vote.id,
    candidateName: vote.candidateName,
    approved,
    approvals,
    total,
    needed,
    at: Date.now(),
  };
  room.voteResult = result;
  saveRooms();
  broadcastRoom(room.id, { type: "vote-result", result });
  log(`room ${room.id}: vote ${approved ? "passed" : "failed"} for ${vote.candidateName ?? vote.candidatePeerId} (${approvals}/${total}, needed ${needed})`);
  return result;
}

function voteKey(person) {
  return person.viewerId || `peer:${person.peerId}`;
}

function roomView(room) {
  if (!room) return null;
  // Same stripping as the store's listing: the owner token is a capability, and
  // for a private room the hash and its issued access tokens are the secret.
  const { ownerToken, passwordSalt, passwordHash, accessTokens, ...rest } = room;
  const people = participants(room.id, room.hostPeerId);
  const hostPresent = people.some((p) => p.isHost);
  return {
    ...rest,
    mediaBase: room.status === "live" || room.status === "ready" ? roomMediaBase(room) : null,
    // Cover for the portal. Null until a transcode has produced one, so the card
    // can render a plain block instead of a broken image.
    poster: fs.existsSync(posterPath(room.id)) ? `/media/${room.id}/poster.jpg` : null,
    viewers: people.length,
    participants: people,
    // `hostAway` is what lets the UI say "房主已离开" instead of silently drifting
    // once the leader's reports stop arriving.
    hostAway: Boolean(room.hostPeerId) && !hostPresent,
    hostTimeoutMs: HOST_TIMEOUT_MS,
    vote: publicVote(room.vote),
    // Kept for a short while so a client that missed the broadcast still learns
    // the outcome on its next poll.
    voteResult: room.voteResult && Date.now() - room.voteResult.at < 30_000 ? room.voteResult : null,
  };
}


/* ------------------------------------------------------- private room access */

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function accessCookieName(roomId) {
  return `room-access-${roomId}`;
}

function setAccessCookie(res, roomId, token) {
  const header =
    `${accessCookieName(roomId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
  const existing = res.getHeader("set-cookie");
  res.setHeader("set-cookie", existing ? [].concat(existing, header) : header);
}

/**
 * Whether this request may see a private room at all.
 *
 * Three ways in: the room is public, the caller holds the owner token (the host
 * must always be able to open their own room), or the caller holds an access
 * cookie issued by a successful password check. The cookie is what the HLS
 * requests carry, so gating here covers the player as well as the API.
 */
function roomAccessGranted(req, room) {
  if (!isPrivate(room)) return true;
  if (isOwner(req, room)) return true;
  return hasAccessToken(room, readCookie(req, accessCookieName(room.id)));
}

// Password guessing is the one thing a 4-character password makes cheap, so
// attempts are budgeted per origin rather than per room.
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const unlockAttempts = new Map();

function unlockLimited(addr) {
  const now = Date.now();
  const entry = unlockAttempts.get(addr);
  if (!entry || now > entry.resetAt) {
    unlockAttempts.set(addr, { count: 1, resetAt: now + UNLOCK_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > UNLOCK_LIMIT;
}

/** Owner check. The token is a capability handed out at creation. */
function isOwner(req, room, body) {
  const header = req.headers["x-room-token"];
  const token = (typeof header === "string" && header) || body?.ownerToken || "";
  if (!token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(room.ownerToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const transcodeJobs = new Map();
/**
 * Rooms with an upload or transcode in flight.
 *
 * `transcodeJobs` alone is not enough: it only exists once ffmpeg has started, so
 * two browsers uploading to the same room at the same time would both pass the
 * check and overwrite each other's source file (observed). This covers the whole
 * window from the start of the PUT until the transcode settles.
 */
const busyRooms = new Set();

/**
 * Room-creation throttle, keyed by origin address.
 *
 * Opening a room is free and is the cheapest way to consume disk, so an
 * accidental double-click or a bored visitor should not be able to fill the
 * machine. Deliberately coarse: this is a club tool on a campus LAN, not a
 * service that needs a real rate limiter.
 */
const roomCreations = new Map();

function creationAllowed(addr) {
  const now = Date.now();
  const recent = (roomCreations.get(addr) ?? []).filter((at) => now - at < ROOM_CREATE_WINDOW_MS);
  if (recent.length >= ROOM_CREATE_LIMIT) {
    roomCreations.set(addr, recent);
    return Math.ceil((ROOM_CREATE_WINDOW_MS - (now - recent[0])) / 60000);
  }
  recent.push(now);
  roomCreations.set(addr, recent);
  return 0;
}

/** Rooms counting against the budget: everything not already deleted. */
function roomCount() {
  return listRooms().length;
}

const transcodeQueue = [];
let activeTranscodes = 0;

/**
 * Queue a transcode, respecting TRANSCODE_CONCURRENCY.
 *
 * Without a queue every upload starts ffmpeg immediately. Two people uploading at
 * once then compete with the node process for CPU while someone may already be
 * watching, which shows up as tracker stalls and stuttering playback in a room
 * that nobody touched. Serialising is the cheap fix: the waiting room shows
 * `queued` and the owner sees their position.
 */
function enqueueTranscode(room, sourceFile) {
  const bad = inspectSource(sourceFile);
  if (bad) {
    busyRooms.delete(room.id);
    updateRoom(room.id, { status: "failed", error: bad });
    return;
  }
  const durationSec = probeDuration(sourceFile);
  updateRoom(room.id, {
    status: "queued",
    durationSec,
    error: null,
    progress: { percent: 0, outTimeSec: 0, speed: "", position: transcodeQueue.length + 1 },
  });
  transcodeQueue.push({ roomId: room.id, sourceFile, durationSec });
  pumpTranscodeQueue();
}

function pumpTranscodeQueue() {
  while (activeTranscodes < TRANSCODE_CONCURRENCY && transcodeQueue.length > 0) {
    const next = transcodeQueue.shift();
    const room = getRoom(next.roomId);
    if (!room) {
      // Room deleted while waiting; drop the job and its files.
      busyRooms.delete(next.roomId);
      continue;
    }
    activeTranscodes += 1;
    runTranscode(room, next.sourceFile, next.durationSec).finally(() => {
      activeTranscodes -= 1;
      pumpTranscodeQueue();
    });
  }
  // Keep the visible queue positions honest.
  transcodeQueue.forEach((job, index) => {
    const room = getRoom(job.roomId);
    if (room && room.status === "queued") {
      room.progress = { ...(room.progress ?? {}), position: index + 1 };
    }
  });
}

async function runTranscode(room, sourceFile, durationSec) {
  updateRoom(room.id, {
    status: "transcoding",
    error: null,
    progress: { percent: 0, outTimeSec: 0, speed: "" },
  });

  let diskCheckedAt = 0;
  let diskExhausted = false;
  let kill = () => {};
  const job = startTranscode(
    {
      sourceFile,
      outputDir: hlsDir(room.id),
      durationSec,
      bitrateKbps: room.bitrateKbps,
    },
    (progress) => {
      const current = getRoom(room.id);
      if (!current || current.status !== "transcoding") return;
      current.progress = {
        percent: progress.percent,
        outTimeSec: progress.outTimeSec,
        speed: progress.speed,
      };

      // Disk watchdog. ffmpeg writes its output unbounded, so the upload-time
      // check alone cannot stop a transcode from filling the filesystem — which
      // would take the OS and every live screening down with it. Throttled
      // because the progress callback fires several times a second.
      const now = Date.now();
      if (now - diskCheckedAt > 2000) {
        diskCheckedAt = now;
        if (!canAccept(0)) {
          log(`room ${room.id}: disk exhausted during transcode, killing ffmpeg`);
          diskExhausted = true;
          kill();
        }
      }
    },
  );

  kill = job.kill;
  transcodeJobs.set(room.id, job);
  return job.promise.then((result) => {
    transcodeJobs.delete(room.id);
    busyRooms.delete(room.id);
    const current = getRoom(room.id);
    if (!current) return;
    if (result.ok) {
      if (!KEEP_SOURCE) {
        // Only after success: on failure the source is what lets the owner retry
        // without transferring the file again.
        try {
          fs.rmSync(sourceFile, { force: true });
        } catch (error) {
          log(`room ${room.id}: could not remove source: ${error.message}`);
        }
      }
      // Ready but not yet started: the owner decides when the screening begins,
      // because everyone's playback clock is pinned to that moment.
      updateRoom(room.id, {
        status: "ready",
        segments: result.segments,
        progress: null,
        error: null,
        syncEpochMs: null,
      });
    } else {
      // Drop the half-written segments: they are useless and, in the disk-full
      // case, keeping them is what prevents recovery.
      discardOutput(room.id);
      updateRoom(room.id, {
        status: "failed",
        segments: 0,
        progress: null,
        error: diskExhausted
          ? `disk ran out during transcoding; partial output discarded. ` +
            `Free space (delete an old room) or upload a shorter file.`
          : result.error,
      });
    }
  });
}

/**
 * Stream the request body to disk.
 *
 * Raw body rather than multipart: the browser can PUT a File object directly,
 * which streams with no pre-buffering and no multipart parser, and the server can
 * enforce limits while writing instead of after.
 *
 * Disk is re-checked during the write, not only up front. The up-front check uses
 * Content-Length, which is (a) absent on chunked uploads and (b) not trustworthy
 * for a client that lies. On this machine free space is smaller than the static
 * per-upload cap, so a cap-only check could still fill the root filesystem and
 * take the whole stack — and the OS — down mid-screening.
 */
function receiveUpload(req, destination, expectedBytes) {
  return new Promise((resolve, reject) => {
    const temporary = `${destination}.part`;
    const out = fs.createWriteStream(temporary);
    let received = 0;
    let aborted = false;
    let checkedAt = 0;

    const fail = (error) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      fs.rm(temporary, { force: true }, () => reject(error));
    };

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        fail(new Error(`upload exceeds limit (${Math.round(MAX_UPLOAD_BYTES / 1048576)} MiB)`));
        req.destroy();
        return;
      }
      // Checking statfs on every chunk would be wasteful; every 8 MiB is frequent
      // enough to stop long before the reserve is eaten.
      if (received - checkedAt > 8 * 1024 * 1024) {
        checkedAt = received;
        if (!canAccept(0)) {
          fail(new Error("disk filled up during upload; aborting to protect the server"));
          req.destroy();
        }
      }
    });
    req.on("aborted", () => fail(new Error("upload aborted by client")));
    req.on("error", fail);
    out.on("error", fail);

    out.on("finish", () => {
      if (aborted) return;
      if (expectedBytes && received !== expectedBytes) {
        fail(new Error(`received ${received} of ${expectedBytes} bytes`));
        return;
      }
      fs.rename(temporary, destination, (error) => {
        if (error) reject(error);
        else resolve({ bytes: received });
      });
    });

    req.pipe(out);
  });
}

function safeExtension(name) {
  const extension = path.extname(String(name ?? "")).replace(/[^.a-z0-9]/gi, "").slice(0, 8);
  return extension.length > 1 ? extension.slice(1) : "bin";
}

/* ------------------------------------------------------------------ routes */

const stun = startStun({ port: STUN_PORT, log });

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/health") return json(res, 200, health());

  if (pathname === "/api/stats") {
    const now = Date.now();
    const roomId = url.searchParams.get("room") || DEFAULT_ROOM_ID;
    const fromParam = Number(url.searchParams.get("from"));
    const toParam = Number(url.searchParams.get("to"));
    const from = Number.isFinite(fromParam) && fromParam > 0 ? fromParam : roundStartedAt;
    const to = Number.isFinite(toParam) && toParam > 0 ? toParam : now;
    return json(res, 200, {
      ...health(roomId),
      roomId,
      roundStartedAt,
      window: windowReport(from, to, roomId),
      cumulative: windowReport(0, now, roomId),
    });
  }

  if (pathname === "/api/report" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body.peerId !== "string" || body.peerId.length === 0) {
      return json(res, 400, { ok: false, error: "peerId required" });
    }
    const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : DEFAULT_ROOM_ID;
    recordSample(roomId, body.peerId, body, originAddress(req));
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }

  if (pathname === "/api/sync" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const requested = Number(body.epochMs);
    syncEpochMs = Number.isFinite(requested) && requested > 0 ? requested : Date.now();
    log(`sync epoch set: ${new Date(syncEpochMs).toISOString()}`);
    return json(res, 200, { ok: true, epochMs: syncEpochMs, serverNowMs: Date.now() });
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    for (const [key, entry] of clients) {
      if (entry.roomId === DEFAULT_ROOM_ID) clients.delete(key);
    }
    roundStartedAt = Date.now();
    roundLabel = typeof body.label === "string" ? body.label : "unlabelled";
    const pinned = Number(body.epochMs);
    syncEpochMs = Number.isFinite(pinned) && pinned > 0 ? pinned : roundStartedAt;
    log(`round reset: ${roundLabel}`);
    return json(res, 200, { ok: true, roundStartedAt, epochMs: syncEpochMs });
  }

  /* ---- room collection */

  // Caddy's forward_auth target for /media/*. Caddy answers the browser only
  // after this returns 2xx, so a private room's segments cannot be fetched by
  // guessing the id — the cookie is the capability, not the URL.
  if (pathname === "/api/media-auth") {
    const uri = String(req.headers["x-forwarded-uri"] ?? req.headers["x-forwarded-path"] ?? "");
    const segments = uri.split("/").filter(Boolean);
    // Match on known room ids instead of a fixed offset: the prefix Caddy reports
    // differs depending on whether the route stripped /media.
    const room = segments.map((segment) => getRoom(segment)).find(Boolean);
    if (!room) {
      res.writeHead(404);
      return res.end();
    }
    if (roomAccessGranted(req, room)) {
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(401);
    return res.end("private room");
  }

  if (pathname === "/api/rooms" && req.method === "GET") {
    // roomView, not the bare store record: the list needs the live viewer count,
    // which only exists in the stats layer.
    // Private rooms are unlisted by definition: the only way in is the id plus
    // the password, so they must not be enumerable from the portal.
    const visible = listRooms().filter((room) => room.visibility !== "private");
    // Coarse on purpose: exact free bytes and the data path are operator
    // details, and a viewer only needs to know whether the box is healthy.
    return json(res, 200, {
      rooms: visible.map(roomView),
      storage: { state: isLowDisk() ? "low" : "ok" },
    });
  }

  if (pathname === "/api/rooms" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    // Anyone may open a room: this is a club tool, not a service with accounts.
    // The token returned once is what later proves ownership.
    const addr = originAddress(req);

    const waitMinutes = creationAllowed(addr);
    if (waitMinutes > 0) {
      return json(res, 429, {
        ok: false,
        error:
          `opened ${ROOM_CREATE_LIMIT} rooms in the last hour; try again in ${waitMinutes} minute(s) ` +
          `or reuse an existing room`,
      });
    }
    if (roomCount() >= MAX_ROOMS) {
      return json(res, 507, {
        ok: false,
        error:
          `server holds the maximum of ${MAX_ROOMS} rooms; delete an old room first ` +
          `(each room keeps its source file and transcoded segments on disk)`,
      });
    }

    const visibility = body.visibility === "private" ? "private" : "public";
    const password = String(body.password ?? "");
    if (visibility === "private" && (password.length < 4 || password.length > 32)) {
      return json(res, 400, { ok: false, error: "私密房间密码需 4–32 个字符" });
    }

    const room = createRoom({ title: body.title, visibility, password });
    // The creator is the first viewer, and HLS requests cannot carry the owner
    // token — so a private room issues its access cookie right here. Without
    // this the host can open the page but every segment is refused.
    if (visibility === "private") setAccessCookie(res, room.id, issueAccessToken(room));
    return json(res, 201, {
      room: roomView(room),
      ownerToken: room.ownerToken,
      roomUrl: `/r/${room.id}`,
    });
  }


  // Password-first entry: the portal's search box submits the password and this
  // tells it which room it opens. Private rooms are not listed, so this is the
  // only way to reach one without the id.
  if (pathname === "/api/rooms/unlock" && req.method === "POST") {
    const addr = originAddress(req);
    if (unlockLimited(addr)) {
      return json(res, 429, { ok: false, error: "尝试次数太多，十分钟后再试" });
    }
    const body = await readJson(req).catch(() => ({}));
    const password = String(body.password ?? "");
    // Newest first: a password reused across rooms opens the most recent one.
    const candidates = listRooms()
      .filter((room) => room.visibility === "private")
      .map((room) => getRoom(room.id))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
    const match = candidates.find((room) => verifyRoomPassword(room, password));
    if (!match) return json(res, 401, { ok: false, error: "密码不对" });
    setAccessCookie(res, match.id, issueAccessToken(match));
    return json(res, 200, { ok: true, roomId: match.id, roomUrl: `/r/${match.id}` });
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([a-z0-9]{4,32})(\/.*)?$/);
  if (roomMatch) {
    const room = getRoom(roomMatch[1]);
    const rest = roomMatch[2] ?? "";
    if (!room) return json(res, 404, { ok: false, error: "room not found" });

    if (rest === "/unlock" && req.method === "POST") {
      const addr = originAddress(req);
      if (unlockLimited(addr)) {
        return json(res, 429, { ok: false, error: "尝试次数太多，十分钟后再试" });
      }
      const body = await readJson(req).catch(() => ({}));
      if (!verifyRoomPassword(room, String(body.password ?? ""))) {
        return json(res, 401, { ok: false, error: "密码不对" });
      }
      setAccessCookie(res, room.id, issueAccessToken(room));
      return json(res, 200, { ok: true, room: roomView(room) });
    }

    // Everything else about a private room needs the password first. This is the
    // gate the room page hits on load; it answers 403 with just enough to render
    // the password form, and nothing about the film.
    if (!roomAccessGranted(req, room)) {
      return json(res, 403, {
        ok: false,
        locked: true,
        error: "this room is private",
        room: { id: room.id, title: room.title, visibility: room.visibility },
      });
    }

    // An expired vote is settled on read as well as by timer: a restart drops the
    // timers, and the next poll must not show a vote that ended minutes ago.
    if (room.vote && Date.now() > room.vote.endsAt) finishVote(room);

    if (rest === "/vote" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      if (room.vote) return json(res, 409, { ok: false, error: "已经有一个投票在进行" });
      if (!hostIsAway(room)) return json(res, 409, { ok: false, error: "房主还在房间里" });

      const people = participants(room.id, room.hostPeerId);
      const me = people.find(
        (person) => person.peerId === body.peerId || (body.viewerId && person.viewerId === body.viewerId),
      );
      if (!me) return json(res, 409, { ok: false, error: "你不在房间里" });
      if (people.length < 2) return json(res, 409, { ok: false, error: "房间里至少要有两个人才能投票" });

      const now = Date.now();
      room.vote = {
        id: crypto.randomUUID(),
        candidatePeerId: me.peerId,
        candidateViewerId: voteKey(me),
        candidateName: me.name || `观众 ${(me.viewerId || me.peerId).slice(-4)}`,
        startedAt: now,
        endsAt: now + VOTE_DURATION_MS,
        eligible: people.map(voteKey),
        ballots: {},
      };
      saveRooms();
      broadcastRoom(room.id, { type: "vote", vote: publicVote(room.vote) });
      scheduleVote(room);
      return json(res, 200, { ok: true, vote: publicVote(room.vote) });
    }

    if (rest === "/vote/cast" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const vote = room.vote;
      if (!vote) return json(res, 409, { ok: false, error: "没有进行中的投票" });
      if (Date.now() > vote.endsAt) {
        finishVote(room);
        return json(res, 409, { ok: false, error: "投票已结束" });
      }
      const key = body.viewerId || `peer:${body.peerId ?? ""}`;
      if (!vote.eligible.includes(key)) return json(res, 403, { ok: false, error: "你没有投票资格" });

      vote.ballots[key] = body.approve === true;
      broadcastRoom(room.id, { type: "vote", vote: publicVote(vote) });
      // Only conclude early once everybody has answered. Concluding as soon as the
      // threshold is met would let a two-person room's applicant settle it alone,
      // and "silence counts as disagreement" only means something if the clock
      // actually runs for the people who have not voted yet.
      if (Object.keys(vote.ballots).length >= vote.eligible.length) finishVote(room);
      return json(res, 200, { ok: true, vote: publicVote(room.vote) });
    }

    if (rest === "" && req.method === "GET") {
      return json(res, 200, {
        room: roomView(room),
        sync: {
          epochMs: room.syncEpochMs,
          serverNowMs: Date.now(),
        },
      });
    }

    if (rest === "/progress" && req.method === "GET") {
      // Cheap poll target for the owner's upload/transcode screen.
      return json(res, 200, {
        status: room.status,
        progress: room.progress ?? null,
        segments: room.status === "transcoding" ? countSegments(hlsDir(room.id)) : room.segments,
        error: room.error ?? null,
      });
    }

    if (rest === "/source" && req.method === "PUT") {
      if (!isOwner(req, room)) return json(res, 403, { ok: false, error: "owner token required" });
      if (busyRooms.has(room.id)) {
        return json(res, 409, {
          ok: false,
          error: "this room is already uploading or processing; wait for it to finish",
        });
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      // Gate on the *whole room*, not just the upload. A source alone may fit
      // while the room as a whole does not, and discovering that in the middle of
      // a transcode means both a failed job and a full disk.
      // A chunked upload has no Content-Length; assume the per-upload cap.
      const want = declared || MAX_UPLOAD_BYTES;
      if (!canAccept(estimatedFootprint(want))) {
        // The numbers go to the log, not to the browser: a viewer does not need
        // the server's free space, and publishing it invites either worry or
        // probing. The operator sees the detail in the control log.
        log(
          `refused upload for ${room.id}: needs ${(estimatedFootprint(want) / 1e9).toFixed(2)} GB, ` +
            `free ${(diskInfo().freeBytes / 1e9).toFixed(2)} GB`,
        );
        return json(res, 507, {
          ok: false,
          error: "服务器空间不足，先删掉一个旧房间，或者传一个短一点的片子。",
        });
      }

      busyRooms.add(room.id);
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "upload"));
      const destination = sourcePath(room.id, safeExtension(filename));
      updateRoom(room.id, { status: "uploading", error: null, progress: null });

      let result;
      try {
        result = await receiveUpload(req, destination, declared);
      } catch (error) {
        busyRooms.delete(room.id);
        updateRoom(room.id, { status: "failed", error: error.message });
        return json(res, 400, { ok: false, error: error.message });
      }

      updateRoom(room.id, {
        sourceName: filename,
        sourceBytes: result.bytes,
        status: "transcoding",
      });
      log(`room ${room.id}: received ${(result.bytes / 1e6).toFixed(1)} MB of ${filename}`);
      enqueueTranscode(room, destination);
      return json(res, 202, { ok: true, bytes: result.bytes, status: getRoom(room.id)?.status });
    }

    if (rest === "/start" && req.method === "POST") {
      if (!isOwner(req, room)) return json(res, 403, { ok: false, error: "owner token required" });
      const body = await readJson(req).catch(() => ({}));
      if (room.status !== "ready" && room.status !== "live") {
        return json(res, 409, { ok: false, error: `room is ${room.status}, not ready` });
      }
      // `delaySec` lets the owner schedule a start a little in the future so late
      // arrivals join at the beginning rather than mid-scene.
      const delayMs = Math.max(0, Math.min(300, Number(body.delaySec) || 0)) * 1000;
      const epochMs = Date.now() + delayMs;
      markStarted(room, epochMs);
      log(`room ${room.id}: started at ${new Date(epochMs).toISOString()}`);
      return json(res, 200, {
        ok: true,
        sync: { epochMs, serverNowMs: Date.now() },
        room: roomView(getRoom(room.id)),
      });
    }

    if (rest === "/host" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const targetPeerId = typeof body.peerId === "string" ? body.peerId : "";
      if (!targetPeerId) return json(res, 400, { ok: false, error: "peerId required" });

      // Two ways to become host: the token holder assigns anyone, or a peer claims
      // an empty seat. The second path is what keeps a screening alive when the
      // host's browser dies instead of handing over.
      // Vacant means never assigned *or* the assigned host stopped reporting —
      // a crash must not leave a room leaderless forever.
      const seatIsVacant = !room.hostPeerId || hostIsAway(room);
      const claimingVacantSeat = seatIsVacant && targetPeerId === body.selfPeerId;
      if (!isOwner(req, room, body) && !claimingVacantSeat) {
        return json(res, 403, { ok: false, error: "only the room owner can transfer host" });
      }

      const live = participants(room.id, room.hostPeerId);
      // The owner's first poll can land before their own first /api/report
      // sample exists, which makes them "not in the room" by this check. Their
      // token already proves the claim is legitimate, so a vacant seat is
      // grantable without presence; anything else still needs a live target.
      const ownerClaimingVacantSeat = seatIsVacant && isOwner(req, room, body);
      const target =
        live.find((p) => p.peerId === targetPeerId) ??
        (ownerClaimingVacantSeat ? { peerId: targetPeerId, name: null, videoTime: 0, playing: false } : null);
      if (!target) {
        return json(res, 409, { ok: false, error: "that viewer is not in the room right now" });
      }

      setHost(room, target.peerId, target.name);
      // Re-anchor to the new host's current position so the handover does not
      // yank everyone backwards or forwards.
      noteHostPosition(room, target.videoTime, target.playing);
      log(`room ${room.id}: host -> ${target.name ?? target.peerId.slice(-4)}`);
      return json(res, 200, { ok: true, room: roomView(getRoom(room.id)) });
    }

    if (rest === "/end" && req.method === "POST") {
      if (!isOwner(req, room)) return json(res, 403, { ok: false, error: "owner token required" });
      updateRoom(room.id, { status: "ended", endedAt: Date.now() });
      return json(res, 200, { ok: true, room: roomView(getRoom(room.id)) });
    }

    if (rest === "" && req.method === "DELETE") {
      if (!isOwner(req, room)) return json(res, 403, { ok: false, error: "owner token required" });
      transcodeJobs.get(room.id)?.kill();
      transcodeJobs.delete(room.id);
      removeRoom(room.id);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: "unknown room operation" });
  }

  return json(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    log(`request failed: ${error.stack ?? error.message}`);
    if (!res.headersSent) json(res, 500, { ok: false, error: error.message });
    else res.end();
  });
});

// Uploads can legitimately take many minutes on campus WiFi; the default 5 minute
// request timeout would cut a large file mid-transfer and lose the whole upload.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

// WebTorrent signaling rides the same listener; Caddy proxies /tracker here.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/tracker")) {
    tracker.ws.handleUpgrade(req, socket, head, (ws) => tracker.ws.emit("connection", ws, req));
    return;
  }

  const danmakuMatch = url.pathname.match(/^\/ws\/room\/([a-z0-9]{4,32})$/);
  if (danmakuMatch) {
    const roomId = danmakuMatch[1];
    danmakuWss.handleUpgrade(req, socket, head, (ws) => danmakuWss.emit("connection", ws, req, roomId));
    return;
  }

  socket.destroy();
});

loadRooms();
// Runs before the first request so a restart immediately reconciles the disk.
sweepIdleRooms();
setInterval(() => sweepIdleRooms(), 60_000).unref();

server.listen(API_PORT, "127.0.0.1", () => log(`api + tracker on http://127.0.0.1:${API_PORT}`));

const shutdown = () => {
  log("shutting down");
  for (const job of transcodeJobs.values()) job.kill();
  stun.close();
  saveRooms();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
