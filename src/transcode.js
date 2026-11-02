// Transcode worker: source file -> HLS, one ffmpeg child per room.
//
// Parameters are the ones validated by the earlier HLS experiments; the
// load-bearing part is the GOP alignment. Without `-g`/`-keyint_min`/
// `-sc_threshold 0` the encoder places keyframes wherever it likes, segment
// boundaries stop matching keyframes, and the muxer pads segments to the next
// keyframe — segments become uneven, P2P transfers get lumpy, and the shared
// playback clock drifts because segment boundaries no longer align with the
// requested 4 s cadence.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SEGMENT_SECONDS = 4;

const log = (message) => process.stderr.write(`[${new Date().toISOString()}] transcode: ${message}\n`);

export function probeDuration(file) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8", timeout: 30_000 },
  );
  const seconds = Number.parseFloat((result.stdout ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Human-readable reason a file cannot be transcoded, or null when it can. */
export function inspectSource(file) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) return `ffprobe rejected the file: ${(result.stderr ?? "").trim().slice(0, 200)}`;
  if (!(result.stdout ?? "").includes("video")) return "no video stream found in the uploaded file";
  return null;
}

/**
 * Start transcoding. Returns a handle whose `promise` settles when ffmpeg exits.
 *
 * `onProgress` receives { outTimeSec, percent, speed } a few times per second,
 * which is what the room page shows while the owner waits.
 */
export function startTranscode({ sourceFile, outputDir, durationSec, bitrateKbps }, onProgress) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const maxrate = Math.round(bitrateKbps * 1.12);
  const bufsize = bitrateKbps * 2;

  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", sourceFile,
    // First video + first audio only: anime sources often carry several audio
    // tracks and subtitle streams. HLS in a browser cannot render PGS/ASS anyway,
    // and extra tracks would multiply segment size for every peer.
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-sn",
    "-dn",
    // Cap at 720p wide; never upscale. Anime at 1080p is not worth the extra
    // uplink when every viewer's WiFi has to carry it.
    "-vf", "scale='min(1280,iw)':-2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-b:v", `${bitrateKbps}k`,
    "-maxrate", `${maxrate}k`,
    "-bufsize", `${bufsize}k`,
    "-g", `${SEGMENT_SECONDS * 25}`,
    "-keyint_min", `${SEGMENT_SECONDS * 25}`,
    "-sc_threshold", "0",
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(outputDir, "seg_%04d.ts"),
    "-progress", "pipe:1",
    "-nostats",
    path.join(outputDir, "index.m3u8"),
  ];

  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  let outTimeSec = 0;
  let speed = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const [key, value] = line.split("=");
      if (key === "out_time_ms") {
        // ffmpeg's out_time_ms is microseconds despite the name.
        outTimeSec = Number(value) / 1e6;
      } else if (key === "speed") {
        speed = value;
      }
    }
    const percent = durationSec > 0 ? Math.min(1, outTimeSec / durationSec) : 0;
    onProgress?.({ outTimeSec, percent, speed });
  });

  const promise = new Promise((resolve) => {
    child.on("error", (error) => {
      log(`spawn failed: ${error.message}`);
      resolve({ ok: false, error: `ffmpeg could not start: ${error.message}` });
    });
    child.on("close", async (code) => {
      const manifest = path.join(outputDir, "index.m3u8");
      if (code === 0 && fs.existsSync(manifest)) {
        const segments = fs
          .readdirSync(outputDir)
          .filter((name) => name.endsWith(".ts")).length;
        log(`done: ${segments} segment(s)`);
        // The portal card needs a cover. Failure here is cosmetic, so it never
        // fails the room: a missing poster just falls back to a plain card.
        const poster = path.join(path.dirname(outputDir), "poster.jpg");
        const second = path.join(outputDir, "seg_0001.ts");
        const first = path.join(outputDir, "seg_0000.ts");
        const source = fs.existsSync(second) ? second : first;
        if (fs.existsSync(source)) await extractPoster(source, poster);
        resolve({ ok: true, segments });
      } else {
        const reason = stderrTail.trim().split("\n").slice(-3).join(" / ") || `exit code ${code}`;
        log(`failed: ${reason}`);
        resolve({ ok: false, error: reason.slice(0, 400) });
      }
    });
  });

  return {
    promise,
    kill() {
      child.kill("SIGKILL");
    },
    pid: child.pid,
  };
}

/** Segment count present on disk, used to show progress after a restart. */
export function countSegments(outputDir) {
  try {
    return fs.readdirSync(outputDir).filter((name) => name.endsWith(".ts")).length;
  } catch {
    return 0;
  }
}

/**
 * One frame from the first segment, for the portal's cover image.
 *
 * Taken from a finished segment rather than the source file: the source is
 * deleted once transcoding succeeds (`ROOM_KEEP_SOURCE=0`), so anything that
 * wants both has to run while the segments are the only artifact left.
 * `scale=w=min(640,iw)` never upscales, and the comma is escaped because ffmpeg
 * splits filter arguments on unescaped commas.
 *
 * No `-ss`: a segment is an independent GOP, so seeking into it lands where the
 * decoder has no reference frames and produces nothing ("co located POCs
 * unavailable"). Frame zero is a keyframe and always decodes; callers pass the
 * second segment when they want to skip a fade-in.
 */
export function extractPoster(segmentFile, posterFile) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-y",
        "-i", segmentFile,
        "-frames:v", "1",
        "-vf", "scale=w=min(640\\,iw):h=-2",
        "-q:v", "4",
        posterFile,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on("error", () => resolve({ ok: false, error: "ffmpeg could not start" }));
    child.on("close", (code) => {
      const ok = code === 0 && fs.existsSync(posterFile) && fs.statSync(posterFile).size > 0;
      if (!ok) log(`poster failed: ${stderr.trim().split("\n").slice(-2).join(" / ") || code}`);
      resolve({ ok, error: ok ? null : stderr.slice(0, 200) });
    });
  });
}

export { SEGMENT_SECONDS };
