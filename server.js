// server.js — чистая версия
import express from "express";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

const app = express();

// Разрешённые фронтенды
const ALLOW = new Set([
  "https://kaplinskiy.github.io",
  "https://call.zababba.com",
  "https://zababba.com",
]);

// Единый CORS-мидлвар (с preflight)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOW.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }
  return res.status(403).json({ ok: false, error: "CORS blocked", origin });
});

app.use(express.json({ limit: "256kb" }));

// Память комнат
const rooms = new Map(); // roomId -> { createdAt, members: Map(memberId->ws), roles: Map(ws->role) }
const ROOM_TTL_MS = 10 * 60 * 1000;

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "0.1.1", rooms: rooms.size, ts: Date.now() });
});

// создать комнату
app.post("/rooms", (req, res) => {
  const roomId = (req.body?.roomId || nanoid(6)).toUpperCase();
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { createdAt: Date.now(), members: new Map(), roles: new Map() });
    console.log("[room.created]", roomId);
  }
  res.json({ ok: true, roomId, expiresInSec: ROOM_TTL_MS / 1000 });
});

// HTTP-сервер
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("HTTP on", server.address().port);
});

// WebSocket
const wss = new WebSocketServer({ noServer: true });

// keep-alive ping
setInterval(() => {
  wss.clients.forEach((client) => {
    try { client.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
  });
}, 20000);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws")) return socket.destroy();

  // Проверка Origin как в CORS
  const origin = req.headers.origin;
  if (origin && !ALLOW.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const roomId = (url.searchParams.get("roomId") || "").toUpperCase();
  const role = url.searchParams.get("role") || "guest";
  if (!roomId) return ws.close(1008, "roomId required");

  let room = rooms.get(roomId);
  if (!room) {
    room = { createdAt: Date.now(), members: new Map(), roles: new Map() };
    rooms.set(roomId, room);
  }
  if (room.members.size >= 2) {
    console.log("[room.full]", roomId);
    return ws.close(1008, "room full");
  }

  const memberId = nanoid(8);
  room.members.set(memberId, ws);
  room.roles.set(ws, role);
  console.log("[join]", roomId, memberId, role);

  // приветствие
  ws.send(JSON.stringify({
    type: "hello",
    roomId, memberId, role,
    createdAt: room.createdAt,
    members: [...room.members.keys()]
  }));

  // уведомим всех
  broadcast(roomId, { type: "member.joined", roomId, memberId, role });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return ws.send(JSON.stringify({ type: "error", code: "bad_json" })); }

    const { type, payload } = msg || {};
    if (!type) return;

    if (["offer", "answer", "ice"].includes(type)) {
      console.log(`[signal] ${roomId} ${type} from ${memberId}`);
      relayToPeer(roomId, memberId, { type, roomId, from: memberId, payload });
    } else if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
    } else {
      ws.send(JSON.stringify({ type: "error", code: "unsupported_type" }));
    }
  });

  ws.on("error", (err) => {
    console.error("[ws.error]", roomId, err?.message || err);
  });

  ws.on("close", (code, reason) => {
    console.log("[ws.close]", roomId, code, reason?.toString());
    room.members.delete(memberId);
    room.roles.delete(ws);
    broadcast(roomId, { type: "member.left", roomId, memberId });
    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log("[room.gc]", roomId);
    }
  });
});

// утилиты
function relayToPeer(roomId, fromMemberId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [mid, ws] of room.members.entries()) {
    if (mid !== fromMemberId && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
}
function broadcast(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const ws of room.members.values()) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
}

// GC старых комнат
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      console.log("[room.expire]", roomId);
      for (const ws of room.members.values()) {
        try { ws.close(1000, "expired"); } catch {}
      }
      rooms.delete(roomId);
    }
  }
}, 60 * 1000);
