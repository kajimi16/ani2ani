// Minimal RFC 5389 STUN binding server (IPv4, no auth, no TURN).
//
// Why this exists: Chrome hides local ICE candidates behind mDNS hostnames.
// mDNS only resolves inside one broadcast domain, so two HITSZ clients on
// *different* subnets cannot use host candidates. A STUN server placed inside
// the campus network hands each client back its own campus-routable address as
// a server-reflexive candidate, which is directly reachable by the other
// client. That is the whole point: no TURN, no public relay, no extra egress.
//
// It never relays media. Worst case it does nothing (candidates fall back to
// mDNS + public STUN).

import dgram from "node:dgram";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

function mappedAddress(type, ipv4, port, xor) {
  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(type, 0);
  attr.writeUInt16BE(8, 2);
  attr.writeUInt8(0, 4);
  attr.writeUInt8(0x01, 5);
  attr.writeUInt16BE(xor ? port ^ 0x2112 : port, 6);
  for (let i = 0; i < 4; i++) {
    const cookieByte = (MAGIC_COOKIE >>> (8 * (3 - i))) & 0xff;
    attr.writeUInt8(xor ? ipv4[i] ^ cookieByte : ipv4[i], 8 + i);
  }
  return attr;
}

function parseIPv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
  return octets;
}

export function startStun({ port, host = "0.0.0.0", log = () => {} }) {
  const socket = dgram.createSocket("udp4");
  const seen = new Map();
  let requests = 0;

  socket.on("message", (msg, rinfo) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== BINDING_REQUEST) return;
    if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return;
    const ipv4 = parseIPv4(rinfo.address);
    if (!ipv4) return;

    requests++;
    seen.set(rinfo.address, (seen.get(rinfo.address) ?? 0) + 1);

    const attrs = Buffer.concat([
      mappedAddress(ATTR_XOR_MAPPED_ADDRESS, ipv4, rinfo.port, true),
      mappedAddress(ATTR_MAPPED_ADDRESS, ipv4, rinfo.port, false),
    ]);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(BINDING_SUCCESS, 0);
    header.writeUInt16BE(attrs.length, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    msg.copy(header, 8, 8, 20);
    socket.send(Buffer.concat([header, attrs]), rinfo.port, rinfo.address);
  });

  socket.on("error", (error) => log(`stun error: ${error.message}`));
  socket.bind(port, host, () => log(`stun listening on udp/${port}`));

  return {
    stats() {
      return {
        port,
        requests,
        clients: [...seen.entries()].map(([address, hits]) => ({ address, hits })),
      };
    },
    close() {
      socket.close();
    },
  };
}
