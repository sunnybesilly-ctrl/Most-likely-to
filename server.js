const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { customAlphabet } = require("nanoid");
const { DEFAULT_QUESTIONS, DEFAULT_DARES } = require("./data");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);
const ROUND_SECONDS = 20;

// roomCode -> room state
const rooms = new Map();

function newRoom(hostSocketId) {
  return {
    hostId: hostSocketId,
    players: new Map(), // socketId -> { name, score }
    order: [], // socketId order for stable display
    phase: "lobby", // lobby | dare-select | question | results | ended
    questionBank: [...DEFAULT_QUESTIONS],
    dareBank: [...DEFAULT_DARES],
    usedQuestions: new Set(),
    currentQuestion: null,
    currentDare: null,
    votes: new Map(), // voterId -> targetId
    timer: null,
    timeLeft: ROUND_SECONDS,
  };
}

function publicPlayerList(room) {
  return room.order
    .filter((id) => room.players.has(id))
    .map((id) => ({
      id,
      name: room.players.get(id).name,
      score: room.players.get(id).score,
      isHost: id === room.hostId,
    }));
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("room:update", {
    code,
    phase: room.phase,
    players: publicPlayerList(room),
    hostId: room.hostId,
    currentDare: room.currentDare,
    dareBank: room.dareBank,
    questionBankSize: room.questionBank.length,
  });
}

function clearTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function pickQuestion(room) {
  const available = room.questionBank.filter((q) => !room.usedQuestions.has(q));
  const pool = available.length > 0 ? available : room.questionBank;
  if (available.length === 0) room.usedQuestions.clear();
  const q = pool[Math.floor(Math.random() * pool.length)];
  room.usedQuestions.add(q);
  return q;
}

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (!room.currentDare) return; // must lock a dare first
  if (room.players.size < 2) return;

  room.phase = "question";
  room.currentQuestion = pickQuestion(room);
  room.votes = new Map();
  room.timeLeft = ROUND_SECONDS;
  clearTimer(room);

  io.to(code).emit("round:start", {
    question: room.currentQuestion,
    dare: room.currentDare,
    players: publicPlayerList(room),
    seconds: ROUND_SECONDS,
  });

  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(code).emit("round:tick", {
      timeLeft: room.timeLeft,
      votesIn: room.votes.size,
      totalPlayers: room.players.size,
    });
    if (room.timeLeft <= 0 || room.votes.size >= room.players.size) {
      finishRound(code);
    }
  }, 1000);
}

function finishRound(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "question") return;
  clearTimer(room);
  room.phase = "results";

  const tally = new Map(); // targetId -> count
  for (const id of room.players.keys()) tally.set(id, 0);
  for (const targetId of room.votes.values()) {
    if (tally.has(targetId)) tally.set(targetId, tally.get(targetId) + 1);
  }

  let maxVotes = 0;
  for (const count of tally.values()) maxVotes = Math.max(maxVotes, count);

  const winners = [];
  for (const [id, count] of tally.entries()) {
    if (count === maxVotes && maxVotes > 0) {
      winners.push(id);
      const p = room.players.get(id);
      if (p) p.score += 1;
    }
  }

  const results = publicPlayerList(room).map((p) => ({
    ...p,
    votes: tally.get(p.id) || 0,
    isWinner: winners.includes(p.id),
  }));

  io.to(code).emit("round:results", {
    results,
    dare: room.currentDare,
    winners: winners.map((id) => room.players.get(id)?.name).filter(Boolean),
  });

  room.currentDare = null;
  broadcastRoom(code);
}

io.on("connection", (socket) => {
  socket.on("host:createRoom", ({ name }, cb) => {
    const code = makeCode();
    const room = newRoom(socket.id);
    room.players.set(socket.id, { name: (name || "Host").slice(0, 20), score: 0 });
    room.order.push(socket.id);
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code });
    broadcastRoom(code);
  });

  socket.on("player:joinRoom", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found. Double-check the code." });
    if (room.players.size >= 20) return cb?.({ ok: false, error: "Room is full." });
    room.players.set(socket.id, { name: (name || "Player").slice(0, 20), score: 0 });
    room.order.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code });
    broadcastRoom(code);
    if (room.phase === "question") {
      // late joiner watches, doesn't vote this round
      socket.emit("round:start", {
        question: room.currentQuestion,
        dare: room.currentDare,
        players: publicPlayerList(room),
        seconds: room.timeLeft,
        spectate: true,
      });
    }
  });

  socket.on("host:setDare", ({ dareText }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    room.currentDare = (dareText || "").trim().slice(0, 200);
    room.phase = "dare-select";
    broadcastRoom(code);
  });

  socket.on("host:addQuestion", ({ text }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    const q = (text || "").trim();
    if (q) room.questionBank.push(q);
    broadcastRoom(code);
  });

  socket.on("host:addDare", ({ text }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    const d = (text || "").trim();
    if (d) room.dareBank.push(d);
    broadcastRoom(code);
  });

  socket.on("host:startRound", () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    startRound(code);
  });

  socket.on("player:vote", ({ targetId }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.phase !== "question") return;
    if (!room.players.has(targetId) return;
    room.votes.set(socket.id, targetId);
    io.to(code).emit("round:tick", {
      timeLeft: room.timeLeft,
      votesIn: room.votes.size,
      totalPlayers: room.players.size,
    });
    if (room.votes.size >= room.players.size) finishRound(code);
  });

  socket.on("host:nextRound", () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    room.phase = "lobby";
    room.currentQuestion = null;
    broadcastRoom(code);
  });

  socket.on("host:endGame", () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || socket.id !== room.hostId) return;
    room.phase = "ended";
    clearTimer(room);
    io.to(code).emit("game:ended", { players: publicPlayerList(room) });
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    room.order = room.order.filter((id) => id !== socket.id);
    room.votes.delete(socket.id);

    if (room.players.size === 0) {
      clearTimer(room);
      rooms.delete(code);
      return;
    }
    if (socket.id === room.hostId) {
      room.hostId = room.order[0]; // migrate host
    }
    broadcastRoom(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Party game running on port ${PORT}`));
