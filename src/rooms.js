// Room store: who is showing what, and where its media lives.
//
// A room is the unit of both product and P2P isolation. Two rooms showing the
// same file must not share a swarm — their viewers are watching different
// moments — so the swarm id is derived per room (see src/player.js).
//
// Everything here is filesystem-backed on purpose: the source file and the HLS
// output are large blobs, so the store keeps only metadata in memory and treats
// the disk as the source of truth for what exists.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_ROOT = process.env.ROOM_DATA_DIR
  ? path.resolve(process.env.ROOM_DATA_DIR)
  : path.resolve("data");

const ROOMS_DIR = path.join(DATA_ROOT, "rooms");
const INDEX_FILE = path.join(DATA_ROOT, "rooms.json");

// Refuse uploads that would leave the machine with no headroom: transcode output
// is roughly the source size, and filling the root filesystem takes the whole
// stack (and the OS) down mid-screening.
const DISK_RESERVE_BYTES = Number(process.env.ROOM_DISK_RESERVE_MB ?? 2048) * 1024 * 1024;

const log = (message) => process.stderr.write(`[${new Date().toISOString()}] rooms: ${message}\n`);

/** @type {Map<string, Room>} */
const rooms = new Map();


function ensureDirs() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

function randomId() {
  // Crockford-ish base32, no vowels to avoid accidental words, no look-alikes.
  const alphabet = "0123456789bcdfghjklmnpqrstvwxyz";
  const bytes = crypto.randomBytes(8);
  let id = "";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

export function freeDiskBytes(target = DATA_ROOT) {
  try {
    const stats = fs.statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

export function diskInfo() {
  return {
    freeBytes: freeDiskBytes(),
    reserveBytes: DISK_RESERVE_BYTES,
  };
}

/** Can we accept `bytes` more data without eating the reserve? */
export function canAccept(bytes) {
  return freeDiskBytes() - Number(bytes || 0) > DISK_RESERVE_BYTES;
}

// A room occupies the uploaded source *and* its transcoded segments. Measured on
// a 900 s 720p source: 296 MB in, 225 segments totalling ~308 MB out, i.e. close
// to 1:1. Checking only the source is what let three uploads through that then
// exhausted the disk mid-transcode.
const OUTPUT_MULTIPLIER = 2.4;

/** Bytes a room will hold once `sourceBytes` has been transcoded. */
export function estimatedFootprint(sourceBytes) {
  return Math.round(Number(sourceBytes || 0) * OUTPUT_MULTIPLIER);
}

export function roomDir(id) {
  return path.join(ROOMS_DIR, id);
}

export const MAX_EPISODES = 3;

/**
 * Where one episode's files live.
 *
 * `null` means the room's own root, which is how rooms created before a room
 * could hold several videos keep working without moving gigabytes around.
 */
export function episodeDir(roomId, episodeId) {
  if (!episodeId || episodeId === "main") return roomDir(roomId);
  return path.join(roomDir(roomId), "ep", episodeId);
}

export function hlsDir(id, episodeId = null) {
  return path.join(episodeDir(id, episodeId), "hls");
}

/**
 * Cover frame for the portal's room cards. Sits next to `hls/`, so Caddy's
 * `/media/*` root serves it without another route.
 */
export function posterPath(id, episodeId = null) {
  return path.join(episodeDir(id, episodeId), "poster.jpg");
}

export function sourcePath(id, extension = "src", episodeId = null) {
  return path.join(episodeDir(id, episodeId), `source.${extension}`);
}

/** The episode a room plays when nothing else is selected. */
export function currentEpisode(room) {
  if (!room?.episodes?.length) return null;
  return room.episodes.find((episode) => episode.id === room.currentEpisodeId) ?? room.episodes[0];
}

/** Media URL prefix for an episode, or the legacy root. */
export function episodeMediaBase(roomId, episode) {
  if (!episode || episode.id === "main") return `/media/${roomId}/`;
  return `/media/${roomId}/ep/${episode.id}/`;
}

function publicRoom(room) {
  // Capabilities and secrets never leave the store: the owner token proves
  // ownership, the password hash and the issued access tokens are exactly what a
  // private room is protecting, and a listing is readable by anyone on the LAN.
  const { ownerToken, passwordSalt, passwordHash, accessTokens, ...rest } = room;
  return rest;
}

export function save() {
  ensureDirs();
  const payload = [...rooms.values()].map((room) => {
    // A host vote is live state with a 30 s clock, not something to resurrect
    // after a restart; the candidate has to ask again.
    const { vote, ...rest } = room;
    return { ...rest, progress: room.status === "transcoding" ? null : room.progress };
  });
  const temporary = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
  fs.renameSync(temporary, INDEX_FILE);
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      save();
    } catch (error) {
      log(`failed to persist rooms: ${error.message}`);
    }
  }, 500);
  saveTimer.unref?.();
}

export function load() {
  ensureDirs();
  if (!fs.existsSync(INDEX_FILE)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch (error) {
    log(`rooms.json unreadable (${error.message}); starting empty`);
    return;
  }
  for (const room of parsed) {
    // A transcode cannot survive a restart: the ffmpeg child is gone. Say so
    // instead of leaving a room that reports "transcoding" forever.
    if (room.status === "transcoding" || room.status === "uploading" || room.status === "queued") {
      room.status = "failed";
      room.error = "server restarted while processing; upload again";
    }
    // Rooms created before multi-episode support keep their single output where
    // it is: it becomes the "main" episode, whose directory is the room root.
    if (!Array.isArray(room.episodes)) room.episodes = [];
    if (room.episodes.length === 0 && room.sourceName) {
      room.episodes.push({
        id: "main",
        name: room.sourceName,
        bytes: room.sourceBytes ?? 0,
        durationSec: room.durationSec ?? 0,
        segments: room.segments ?? 0,
        bitrateKbps: room.bitrateKbps ?? 0,
        status: room.segments > 0 ? "ready" : (room.status === "failed" ? "failed" : "transcoding"),
        createdAt: room.createdAt,
      });
      room.currentEpisodeId = "main";
    }
    rooms.set(room.id, room);
  }
  log(`loaded ${rooms.size} room(s) from disk`);
}

/**
 * A private room is unlisted and requires its password to open — including for
 * the HLS segments, which is what makes the password mean anything.
 */
export function isPrivate(room) {
  return room?.visibility === "private";
}

const SCRYPT_KEYLEN = 32;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
}

export function verifyRoomPassword(room, password) {
  if (!isPrivate(room) || typeof password !== "string" || password.length === 0) return false;
  const expected = Buffer.from(String(room.passwordHash ?? ""), "hex");
  const actual = Buffer.from(hashPassword(password, room.passwordSalt), "hex");
  if (expected.length !== actual.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// Access tokens are capabilities: whoever holds one may watch the room's media.
// They are bounded so a room that has been open all term does not accumulate
// every visitor forever.
const MAX_ACCESS_TOKENS = 50;

export function issueAccessToken(room) {
  const token = crypto.randomBytes(24).toString("hex");
  room.accessTokens = [...(room.accessTokens ?? []), { token, at: Date.now() }].slice(-MAX_ACCESS_TOKENS);
  save();
  return token;
}

export function hasAccessToken(room, token) {
  if (!isPrivate(room) || typeof token !== "string" || token.length === 0) return false;
  return (room.accessTokens ?? []).some((entry) => {
    const a = Buffer.from(String(entry.token));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export function createRoom({ title, ownerToken, visibility, password }) {
  ensureDirs();
  let id = randomId();
  while (rooms.has(id)) id = randomId();

  const privateRoom = visibility === "private";
  const room = {
    id,
    title: String(title ?? "").trim().slice(0, 80) || "未命名放映",
    // Public rooms are listed on the portal; private ones are reachable only by
    // id plus password, so they never appear in a listing.
    visibility: privateRoom ? "private" : "public",
    ownerToken: ownerToken ?? crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now(),
    status: "created",
    // One room can hold a few videos; the host picks which one is screening.
    episodes: [],
    currentEpisodeId: null,
    sourceName: null,
    sourceBytes: 0,
    durationSec: 0,
    segments: 0,
    bitrateKbps: Number(process.env.ROOM_BITRATE_KBPS ?? 2500),
    syncEpochMs: null,
    // Host ownership is per-session and by peer, not by token: the owner token is
    // a durable capability, but "who is driving the screening right now" is a live
    // fact that can be handed over. `hostPeerId` is whoever currently leads.
    hostPeerId: null,
    hostName: null,
    // Last known playback position of the host. Followers derive their target from
    // this instead of a wall-clock epoch, because the leader may pause, seek or
    // recover from a stall — a fixed epoch cannot express any of that.
    hostRef: null,
    startedAt: null,
    endedAt: null,
    error: null,
    progress: null,
  };

  if (privateRoom) {
    room.passwordSalt = crypto.randomBytes(16).toString("hex");
    room.passwordHash = hashPassword(password, room.passwordSalt);
    room.accessTokens = [];
  }

  fs.mkdirSync(roomDir(id), { recursive: true });
  rooms.set(id, room);
  save();
  log(`created room ${id} (${room.title})`);
  return room;
}

export function getRoom(id) {
  return rooms.get(id);
}

export function listRooms() {
  return [...rooms.values()]
    .filter((room) => room.status !== "deleted")
    .sort((a, b) => {
      // Watchable rooms first, then newest.
      const rank = (room) => (room.status === "live" ? 0 : room.status === "ready" ? 1 : 2);
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    })
    .map(publicRoom);
}

export function startedAt(room) {
  return room.startedAt ?? null;
}

export function markStarted(room, epochMs = Date.now()) {
  room.status = "live";
  room.startedAt = epochMs;
  room.syncEpochMs = epochMs;
  room.endedAt = null;
  // The host is re-anchored to zero on every start so a restart is a clean slate.
  room.hostRef = { videoTime: 0, at: epochMs, playing: true };
  saveSoon();
}

/** Hand the screening to another peer. */
export function setHost(room, peerId, name, viewerId = null) {
  room.hostPeerId = peerId;
  room.hostName = name ?? null;
  // The seat is tied to a person, not a page load: peerId changes on every
  // refresh, viewerId does not. This is what lets the same host reclaim the seat
  // (or keep controlling the room) after reloading.
  room.hostViewerId = viewerId ?? null;
  saveSoon();
}

/**
 * Record the host's playback position.
 *
 * Kept as (position, timestamp) rather than a single number so a follower can
 * extrapolate through the host's natural playback and freeze when the host pauses.
 */
export function noteHostPosition(room, videoTime, playing) {
  room.hostRef = { videoTime, at: Date.now(), playing: Boolean(playing) };
}

export function updateRoom(id, patch) {
  const room = rooms.get(id);
  if (!room) return undefined;
  Object.assign(room, patch);
  saveSoon();
  return room;
}

/** Drop transcoded output, keeping the source so the owner can retry. */
export function discardOutput(id, episodeId = null) {
  try {
    fs.rmSync(hlsDir(id, episodeId), { recursive: true, force: true });
  } catch (error) {
    log(`failed to discard output for ${id}: ${error.message}`);
  }
}

export function removeRoom(id) {
  const room = rooms.get(id);
  if (!room) return false;
  rooms.delete(id);
  try {
    fs.rmSync(roomDir(id), { recursive: true, force: true });
  } catch (error) {
    log(`failed to delete files for ${id}: ${error.message}`);
  }
  save();
  log(`deleted room ${id}`);
  return true;
}

export { DATA_ROOT, ROOMS_DIR };
