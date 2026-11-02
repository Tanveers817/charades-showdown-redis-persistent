import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  MAX_PLAYERS, MIN_PLAYERS, TURN_MS, MAX_PASSES, WORDS,
  makeRoomCode, chooseWord, createPlayer, isCorrectGuess,
  scoreGuess, scorePerformer
} from "./game.js";

const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, service: "charades-showdown" }));
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // WebSocket is preferred; polling remains as a compatibility fallback.
  // Socket.IO automatically reconnects clients after transient network loss.
  cors: { origin: process.env.CLIENT_ORIGIN?.split(",") || "*" },
  transports: ["websocket", "polling"],
  pingInterval: 20_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1e6
});

const rooms = new Map();
const REDIS_URL = process.env.REDIS_URL;
let redisClient = null;
let redisReady = false;

async function initializeRedis() {
  if (!REDIS_URL) {
    console.warn("REDIS_URL is not set; using in-memory development mode.");
    return;
  }
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", err => console.error("Redis error:", err.message));
  await redisClient.connect();
  const pubClient = redisClient;
  const subClient = pubClient.duplicate();
  subClient.on("error", err => console.error("Redis subscriber error:", err.message));
  await subClient.connect();
  io.adapter(createAdapter(pubClient, subClient));
  redisReady = true;
  console.log("Redis connected; Socket.IO Redis adapter enabled.");
}

// Cache a public snapshot for fast room lookups/diagnostics across app instances.
// This is a cache, not the authoritative game-state store; in-memory room state
// remains authoritative in this starter. TTL prevents abandoned keys accumulating.
async function cacheRoomSnapshot(room) {
  if (!redisReady || !redisClient) return;
  try {
    await redisClient.set(`charades:room:${room.code}`, JSON.stringify(publicRoom(room)), { EX: 60 * 60 * 6 });
  } catch (err) {
    console.error("Room cache write failed:", err.message);
  }
}

const timers = new Map();
const publicRoom = room => ({
  code: room.code, hostId: room.hostId, status: room.status,
  round: room.round, totalRounds: room.totalRounds, turnIndex: room.turnIndex,
  players: [...room.players.values()].map(({ id, name, avatar, score, correctGuesses, firstGuesses, performerPoints, connected, ready }) =>
    ({ id, name, avatar, score, correctGuesses, firstGuesses, performerPoints, connected, ready })),
  turn: room.turn ? { performerId: room.turn.performerId, mode: room.turn.mode, endsAt: room.turn.endsAt, category: room.turn.word.category, difficulty: room.turn.word.difficulty, passesLeft: room.turn.passesLeft, correctPlayerIds: [...room.turn.correctPlayerIds] } : null
});
const emitRoom = room => {
  io.to(room.code).emit("room:update", publicRoom(room));
  void cacheRoomSnapshot(room);
};
const clearTurnTimer = code => { if (timers.has(code)) clearTimeout(timers.get(code)); timers.delete(code); };
const sendPrivatePrompt = (room, playerId) => {
  const player = room.players.get(playerId);
  if (player) io.to(player.socketId).emit("turn:prompt", { answer: room.turn.word.answer, mode: room.turn.mode, category: room.turn.word.category, difficulty: room.turn.word.difficulty });
};
const startTurn = room => {
  clearTurnTimer(room.code);
  const ids = [...room.players.keys()];
  const performerId = ids[room.turnIndex % ids.length];
  const used = room.usedWords;
  const word = chooseWord(WORDS, room.difficulty, used);
  used.add(word.answer);
  room.turn = {
    performerId, word, mode: Math.random() < 0.5 ? "act" : "draw",
    endsAt: Date.now() + TURN_MS, passesLeft: MAX_PASSES,
    correctPlayerIds: new Set(), firstCorrectId: null, anyCorrect: false
  };
  room.status = "playing";
  io.to(room.code).emit("turn:started", { performerId, mode: room.turn.mode, endsAt: room.turn.endsAt, category: word.category });
  sendPrivatePrompt(room, performerId);
  emitRoom(room);
  timers.set(room.code, setTimeout(() => finishTurn(room, "time"), TURN_MS));
};
function finishTurn(room, reason = "finished") {
  if (!room || room.status !== "playing" || !room.turn) return;
  clearTurnTimer(room.code);
  const turn = room.turn;
  const performer = room.players.get(turn.performerId);
  if (performer && turn.anyCorrect) {
    performer.score += scorePerformer(true);
    performer.performerPoints += 100;
  }
  io.to(room.code).emit("turn:ended", {
    answer: turn.word.answer, reason,
    correctPlayerIds: [...turn.correctPlayerIds],
    performerId: turn.performerId,
    performerAward: turn.anyCorrect ? 100 : 0
  });
  room.turnIndex += 1;
  const totalTurns = room.players.size * room.totalRounds;
  if (room.turnIndex >= totalTurns) {
    room.status = "finished";
    room.turn = null;
    emitRoom(room);
    io.to(room.code).emit("game:finished", { leaderboard: leaderboard(room) });
  } else {
    room.status = "intermission";
    room.turn = null;
    emitRoom(room);
    room.nextTurnTimer = setTimeout(() => {
      if (rooms.has(room.code) && room.status === "intermission") startTurn(room);
    }, 3500);
  }
}
function leaderboard(room) {
  return [...room.players.values()].sort((a, b) =>
    b.score - a.score || b.correctGuesses - a.correctGuesses || b.firstGuesses - a.firstGuesses
  ).map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, score: p.score, correctGuesses: p.correctGuesses, firstGuesses: p.firstGuesses, performerPoints: p.performerPoints }));
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  const player = room.players.get(socket.id);
  if (player) player.connected = false;
  if (room.status === "lobby" && player) {
    room.players.delete(socket.id);
  } else if (room.status !== "finished" && player) {
    // Keep a disconnected player's seat and score for reconnection.
  }
  if (room.hostId === socket.id) {
    const next = [...room.players.values()].find(p => p.connected);
    if (next) room.hostId = next.id;
  }
  if (room.players.size === 0 || (room.status === "lobby" && room.players.size === 0)) {
    clearTurnTimer(code);
    if (room.nextTurnTimer) clearTimeout(room.nextTurnTimer);
    rooms.delete(code);
  } else {
    emitRoom(room);
  }
}
io.on("connection", socket => {
  socket.on("room:create", ({ name, avatar }, ack = () => {}) => {
    if (socket.data.roomCode) leaveRoom(socket);
    const code = makeRoomCode(new Set(rooms.keys()));
    const room = { code, hostId: socket.id, players: new Map(), status: "lobby", round: 1, totalRounds: 2, turnIndex: 0, turn: null, usedWords: new Set(), difficulty: "mixed" };
    const player = createPlayer(socket.id, String(name || "Host"), avatar);
    player.socketId = socket.id;
    room.players.set(socket.id, player);
    rooms.set(code, room);
    socket.join(code); socket.data.roomCode = code;
    ack({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", ({ code, name, avatar }, ack = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return ack({ ok: false, error: "Room not found." });
    if (room.status !== "lobby") return ack({ ok: false, error: "This game has already started." });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: "Room is full (8 players maximum)." });
    if (socket.data.roomCode) leaveRoom(socket);
    const player = createPlayer(socket.id, String(name || "Player"), avatar);
    player.socketId = socket.id;
    room.players.set(socket.id, player);
    socket.join(room.code); socket.data.roomCode = room.code;
    ack({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("player:ready", ({ ready }, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!player || room.status !== "lobby") return ack({ ok: false });
    player.ready = Boolean(ready);
    emitRoom(room); ack({ ok: true });
  });

  socket.on("game:start", (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return ack({ ok: false, error: "Only the host can start." });
    if (room.players.size < MIN_PLAYERS) return ack({ ok: false, error: "At least 2 players are required." });
    if ([...room.players.values()].some(p => !p.ready && p.id !== room.hostId)) return ack({ ok: false, error: "Wait for everyone to be ready." });
    room.round = 1; room.turnIndex = 0; room.usedWords.clear();
    ack({ ok: true }); startTurn(room);
  });

  socket.on("guess:submit", ({ guess }, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const turn = room?.turn;
    if (!room || room.status !== "playing" || !turn) return ack({ ok: false, error: "No active turn." });
    if (socket.id === turn.performerId) return ack({ ok: false, error: "The performer cannot guess." });
    if (turn.correctPlayerIds.has(socket.id)) return ack({ ok: false, error: "You already guessed correctly." });
    if (!String(guess || "").trim() || String(guess).length > 80) return ack({ ok: false, error: "Enter a guess up to 80 characters." });
    if (!isCorrectGuess(guess, turn.word.answer)) return ack({ ok: true, correct: false });
    const firstCorrect = !turn.firstCorrectId;
    turn.firstCorrectId ||= socket.id;
    turn.correctPlayerIds.add(socket.id);
    turn.anyCorrect = true;
    const player = room.players.get(socket.id);
    if (player) {
      const points = scoreGuess({ firstCorrect, difficult: turn.word.difficulty === "hard" });
      player.score += points;
      player.correctGuesses += 1;
      if (firstCorrect) player.firstGuesses += 1;
    }
    ack({ ok: true, correct: true, points, firstCorrect });
    io.to(room.code).emit("guess:correct", { playerId: socket.id, playerName: player?.name, firstCorrect });
    emitRoom(room);
  });

  socket.on("turn:pass", (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.turn || room.turn.performerId !== socket.id) return ack({ ok: false, error: "Only the performer can pass." });
    if (room.turn.passesLeft <= 0) return ack({ ok: false, error: "No passes remaining." });
    room.turn.passesLeft -= 1;
    const word = chooseWord(WORDS, room.difficulty, room.usedWords);
    room.usedWords.add(word.answer);
    room.turn.word = word;
    room.turn.mode = Math.random() < 0.5 ? "act" : "draw";
    sendPrivatePrompt(room, socket.id);
    io.to(room.code).emit("turn:passed", { mode: room.turn.mode, category: word.category, passesLeft: room.turn.passesLeft });
    emitRoom(room); ack({ ok: true });
  });

  socket.on("draw:stroke", ({ points, color, width }, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.turn || room.turn.performerId !== socket.id || room.turn.mode !== "draw") return ack?.({ ok: false });
    if (!Array.isArray(points) || points.length > 80) return ack?.({ ok: false });
    const safePoints = points.slice(0, 80).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }));
    socket.to(room.code).volatile.emit("draw:stroke", {
      points: safePoints, color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#222222",
      width: Math.max(1, Math.min(16, Number(width) || 4))
    });
    ack?.({ ok: true });
  });
  socket.on("draw:clear", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room?.turn?.performerId === socket.id && room.turn.mode === "draw") io.to(room.code).emit("draw:clear");
  });
  socket.on("disconnect", () => leaveRoom(socket));
});

const port = Number(process.env.PORT || 3001);
initializeRedis()
  .then(() => httpServer.listen(port, () => console.log(`Charades Showdown server listening on ${port}`)))
  .catch(err => {
    console.error("Redis initialization failed:", err);
    process.exit(1);
  });
