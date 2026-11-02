// Danmaku: comments that scroll across the picture, plus a sidebar transcript.
//
// Two constraints shape this module:
//
// 1. The overlay must live *inside* the player's fullscreen element, or it
//    disappears the moment someone goes fullscreen — which is exactly when a
//    screening is actually watched.
// 2. The sidebar must live *outside* that element, so fullscreen hides it by
//    itself instead of needing fullscreen-change bookkeeping.
//
// Comments are anchored to the sender's playhead for the record, but rendered on
// arrival: a screening is watched together, so replaying by timestamp would make
// the overlay lag behind the conversation.

const LANE_HEIGHT_PX = 30;
const SCROLL_SPEED_PX_PER_S = 92;
const LANE_FREE_AFTER_S = 1.2;
const MAX_ON_SCREEN = 42;
const MAX_SIDEBAR_ROWS = 300;

/**
 * @param {object} options
 * @param {string} options.roomId
 * @param {string|null} options.name  display name, may be null
 * @param {string} options.peerId
 * @param {() => number} options.videoTime current playhead
 * @param {HTMLElement} options.playerContainer Plyr's container (fullscreen root)
 * @param {HTMLUListElement} options.sidebar list element outside the player
 */
export function createDanmaku({ roomId, name, peerId, videoTime, playerContainer, sidebar }) {
  if (!roomId || !playerContainer) return null;

  const layer = document.createElement("div");
  layer.className = "danmaku-layer";
  layer.setAttribute("aria-hidden", "true");
  playerContainer.appendChild(layer);

  const lanes = [];
  const live = new Set();
  let socket = null;
  let connected = false;

  function laneFor(width) {
    const now = performance.now() / 1000;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] <= now) {
        lanes[i] = now + LANE_FREE_AFTER_S;
        return i;
      }
    }
    if (lanes.length < 14) {
      lanes.push(now + LANE_FREE_AFTER_S);
      return lanes.length - 1;
    }
    // Every lane busy: drop rather than overlap. A wall of unreadable text is
    // worse than a missing line.
    void width;
    return -1;
  }

  function render(item) {
    if (live.size >= MAX_ON_SCREEN) return;
    const node = document.createElement("span");
    node.className = "danmaku-item";
    node.textContent = item.text;
    layer.appendChild(node);

    const width = node.offsetWidth || 120;
    const lane = laneFor(width);
    if (lane < 0) {
      node.remove();
      return;
    }

    const trackWidth = layer.clientWidth || playerContainer.clientWidth || 640;
    const distance = trackWidth + width;
    const duration = distance / SCROLL_SPEED_PX_PER_S;

    node.style.top = `${6 + lane * LANE_HEIGHT_PX}px`;
    node.style.animationDuration = `${duration}s`;
    // Starting off the right edge and ending fully past the left one keeps the
    // whole travel inside one transform, which the compositor can run alone.
    node.style.setProperty("--danmaku-from", `${trackWidth}px`);
    node.style.setProperty("--danmaku-to", `${-width}px`);

    live.add(node);
    node.addEventListener("animationend", () => {
      live.delete(node);
      node.remove();
    });
  }

  function appendSidebar(item, { scroll = true } = {}) {
    if (!sidebar) return;
    const row = document.createElement("li");
    row.className = "danmaku-row";

    const who = document.createElement("span");
    who.className = "danmaku-who";
    who.textContent = item.name || `观众 ${String(item.peerId ?? "").slice(-4)}`;

    const what = document.createElement("span");
    what.className = "danmaku-text";
    what.textContent = item.text;

    row.append(who, what);
    sidebar.appendChild(row);

    while (sidebar.children.length > MAX_SIDEBAR_ROWS) sidebar.firstElementChild.remove();
    if (scroll) sidebar.scrollTop = sidebar.scrollHeight;
  }

  function onMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "history") {
      // History fills the transcript but does not replay over the video.
      for (const item of payload.items ?? []) appendSidebar(item, { scroll: false });
      if (sidebar) sidebar.scrollTop = sidebar.scrollHeight;
      return;
    }
    if (payload.type === "danmaku" && payload.item) {
      render(payload.item);
      appendSidebar(payload.item);
    }
  }

  function connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/ws/room/${roomId}`);
    socket.addEventListener("open", () => {
      connected = true;
      document.dispatchEvent(new CustomEvent("danmaku-status", { detail: { connected } }));
    });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", () => {
      connected = false;
      document.dispatchEvent(new CustomEvent("danmaku-status", { detail: { connected } }));
      // A screening lasts hours and campus WiFi drops; reconnect rather than
      // silently losing everyone's comments.
      setTimeout(connect, 4000);
    });
    socket.addEventListener("error", () => socket?.close());
  }

  function send(text) {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean || !socket || socket.readyState !== 1) return false;
    socket.send(
      JSON.stringify({
        type: "danmaku",
        text: clean,
        name: name || null,
        peerId,
        videoTime: videoTime(),
      }),
    );
    return true;
  }

  connect();

  return {
    send,
    isConnected: () => connected,
    destroy() {
      socket?.close();
      layer.remove();
    },
  };
}
