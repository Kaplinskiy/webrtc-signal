import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

const app = express();

// Разрешаем GitHub Pages origin (можно '*' пока отладка)
const ALLOW_ORIGIN = "https://kaplinskiy.github.io";

// Базовый CORS для всех обычных ответов
app.use(cors({
  origin: ALLOW_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.options("/rooms", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
  });

// Явно отвечаем на preflight для всех путей
app.options("*", cors({
  origin: ALLOW_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json({ limit: "256kb" }));

// --- простая память-комнат: { [roomId]: { createdAt, members: Map(memberId -> ws), roles: Map(ws -> role) } }
const rooms = new Map();
const ROOM_TTL_MS = 10 * 60 * 1000; // 10 минут

// health + версия
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "0.1.0", rooms: rooms.size, ts: Date.now() });
});

// создать комнату и одноразовую ссылку
app.post("/rooms", (req, res) => {
  const roomId = (req.body?.roomId || nanoid(6)).toUpperCase();
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { createdAt: Date.now(), members: new Map(), roles: new Map() });
    console.log("[room.created]", roomId);
  }
  // joinLink: клиент сам подставит свой frontend-домен; здесь просто roomId
  res.json({ roomId, expiresInSec: ROOM_TTL_MS / 1000 });
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("HTTP on", server.address().port);
});

// WS: wss://host/ws?roomId=XXXX&role=caller|callee
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws")) return socket.destroy();
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

  // сообщаем второму участнику о входе
  broadcast(roomId, { type: "member.joined", roomId, memberId, role });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return ws.send(JSON.stringify({ type: "error", code: "bad_json" })); }

    const { type, payload } = msg || {};
    if (!type) return;

    // пересылаем партнёру только ограниченные типы
    if (["offer", "answer", "ice"].includes(type)) {
      console.log(`[signal] ${roomId} ${type} from ${memberId}`);
      relayToPeer(roomId, memberId, { type, roomId, from: memberId, payload });
    } else if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
    } else {
      ws.send(JSON.stringify({ type: "error", code: "unsupported_type" }));
    }
  });

  ws.on("close", () => {
    console.log("[leave]", roomId, memberId);
    room.members.delete(memberId);
    room.roles.delete(ws);
    broadcast(roomId, { type: "member.left", roomId, memberId });
    // удалить пустую комнату
    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log("[room.gc]", roomId);
    }
  });

  // приветствие + краткий статус
  ws.send(JSON.stringify({
    type: "hello",
    roomId,
    memberId,
    role,
    createdAt: rooms.get(roomId)?.createdAt,
    members: [...rooms.get(roomId)?.members.keys()]
  }));
});

// переслать сообщению единственному «партнёру» в комнате
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

// простая очистка старых комнат
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
