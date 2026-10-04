const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { customAlphabet, nanoid } = require("nanoid");
const { DEFAULT_QUESTIONS, DEFAULT_DARES, DARE_LABELS } = require("./data");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 15000, pingTimeout: 45000 });

app.get("/health", (_req, res) => res.type("text").send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

const DARE_SECONDS = 12;
const LOCK_SECONDS = 8;
const QUESTION_SECONDS = 15;
const MAX_RESHUFFLES = 2;
const MAX_PLAYERS = 20;
const MAX_CUSTOM = 60;
const GRACE_MS = 20 * 60 * 1000; // how long a dropped phone keeps its seat
const DARE_CATS = Object.keys(DEFAULT_DARES);
const ACTIVE = ["dare", "lock", "question", "results"];

// roomCode -> room
const rooms = new Map();

// ---------- helpers ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function normalizeQuestion(t) {
  let q = clean(t, 140);
  if (!q) return "";
  if (!/^who/i.test(q)) q = "Who's most likely to " + q.replace(/^to\s+/i, "");
  if (!/\?$/.test(q)) q += "?";
  return q.charAt(0).toUpperCase() + q.slice(1);
}

function newRoom(code) {
  const dareDecks = {};
  for (const c of DARE_CATS) dareDecks[c] = shuffle(DEFAULT_DARES[c]);
  return {
    code,
    creatorId: null,
    hostId: null,
    restored: false,
    hostClaimed: false,
    players: new Map(), // playerId -> { id, name, score, passes, online, socketId, lastSeen }
    order: [],
    phase: "lobby", // lobby | dare | lock | question | results | ended
    round: 0,
    questionDeck: shuffle(DEFAULT_QUESTIONS),
    customQuestions: [],
    dareDecks,
    customDares: [],
    dareOptions: [],
    dareVotes: new Map(), // playerId -> optionId | "reshuffle"
    reshuffles: 0,
    lockedDare: null,
    optOuts: new Set(),
    question: null,
    targets: [],
    votes: new Map(), // playerId -> targetId
    ready: new Set(),
    results: null,
    timer: null,
    timeLeft: 0,
    timerTotal: 0,
    notice: null,
    noticeId: 0,
  };
}

function setNotice(room, text) {
  room.notice = text ? { id: ++room.noticeId, text, at: Date.now() } : null;
}

const onlinePlayers = (room) => [...room.players.values()].filter((p) => p.online);
const readyNeeded = (room) => Math.floor(onlinePlayers(room).length / 2) + 1;
function everyoneVoted(room, map) {
  const on = onlinePlayers(room);
  return on.length > 0 && on.every((p) => map.has(p.id));
}

function uniqueName(room, name, pid) {
  const base = clean(name, 20) || "Player";
  const taken = (x) =>
    [...room.players.values()].some((p) => p.id !== pid && p.name.toLowerCase() === x.toLowerCase());
  let n = base;
  let i = 2;
  while (taken(n)) n = `${base.slice(0, 17)} ${i++}`;
  return n;
}

function addPlayer(room, pid, name, socketId, score = 0) {
  room.players.set(pid, {
    id: pid,
    name: uniqueName(room, name, pid),
    score,
    passes: 0,
    online: true,
    socketId,
    lastSeen: Date.now(),
  });
  room.order.push(pid);
}

function removePlayer(room, pid) {
  room.players.delete(pid);
  room.order = room.order.filter((id) => id !== pid);
  room.dareVotes.delete(pid);
  room.votes.delete(pid);
  room.optOuts.delete(pid);
  room.ready.delete(pid);
}

function migrateHost(room) {
  const next = room.order.map((id) => room.players.get(id)).find((p) => p && p.online);
  if (next) room.hostId = next.id;
}

function applySeen(room, q, d) {
  const sq = new Set((Array.isArray(q) ? q : []).slice(0, 400).map(String));
  const sd = new Set((Array.isArray(d) ? d : []).slice(0, 400).map(String));
  room.questionDeck = room.questionDeck.filter((x) => !sq.has(x));
  for (const c of DARE_CATS) room.dareDecks[c] = room.dareDecks[c].filter((x) => !sd.has(x));
}

// ---------- decks ----------
function drawDare(room, cat) {
  if (!room.dareDecks[cat].length) room.dareDecks[cat] = shuffle(DEFAULT_DARES[cat]);
  return room.dareDecks[cat].shift();
}

function dealDares(room) {
  const cats = shuffle(DARE_CATS).slice(0, 4);
  const opts = cats.map((cat) => ({ text: drawDare(room, cat), cat, by: null }));
  if (room.customDares.length) {
    const swapped = opts[opts.length - 1];
    room.dareDecks[swapped.cat].push(swapped.text);
    const c = room.customDares.shift();
    opts[opts.length - 1] = { text: c.text, cat: "custom", by: c.by };
  }
  opts.forEach((o, i) => {
    o.id = "d" + i;
  });
  room.dareOptions = opts;
}

function returnDare(room, o) {
  if (!o) return;
  if (o.cat === "custom") room.customDares.push({ text: o.text, by: o.by });
  else room.dareDecks[o.cat].push(o.text);
}

function pickQuestion(room) {
  if (!room.questionDeck.length) {
    room.questionDeck = shuffle([...DEFAULT_QUESTIONS, ...room.customQuestions]);
  }
  return room.questionDeck.shift();
}

// ---------- state out ----------
function progress(room) {
  const on = onlinePlayers(room);
  switch (room.phase) {
    case "dare":
      return { done: on.filter((p) => room.dareVotes.has(p.id)).length, total: on.length };
    case "lock":
      return { done: on.filter((p) => room.optOuts.has(p.id)).length, total: on.length };
    case "question":
      return { done: on.filter((p) => room.votes.has(p.id)).length, total: on.length };
    case "results":
      return { done: on.filter((p) => room.ready.has(p.id)).length, total: readyNeeded(room) };
    default:
      return { done: 0, total: on.length };
  }
}

function dareView(d) {
  return d ? { text: d.text, cat: d.cat, by: d.by, label: DARE_LABELS[d.cat] || "Dare" } : null;
}

function buildState(room, pid) {
  const me = room.players.get(pid);
  const s = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    you: {
      id: pid,
      name: me.name,
      score: me.score,
      isHost: pid === room.hostId,
      ready: room.ready.has(pid),
      sittingOut: room.optOuts.has(pid),
    },
    players: room.order
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        passes: p.passes,
        online: p.online,
        isHost: p.id === room.hostId,
      })),
    timeLeft: room.timeLeft,
    timerTotal: room.timerTotal,
    progress: progress(room),
    notice:
      room.notice && Date.now() - room.notice.at < 6000
        ? { id: `${room.code}:${room.notice.id}`, text: room.notice.text }
        : null,
  };

  if (room.phase === "dare") {
    const counts = {};
    let reshuffleVotes = 0;
    for (const v of room.dareVotes.values()) {
      if (v === "reshuffle") reshuffleVotes++;
      else counts[v] = (counts[v] || 0) + 1;
    }
    s.dare = {
      options: room.dareOptions.map((o) => ({
        id: o.id,
        text: o.text,
        by: o.by,
        label: DARE_LABELS[o.cat] || "Dare",
        votes: counts[o.id] || 0,
      })),
      reshuffleVotes,
      canReshuffle: room.reshuffles < MAX_RESHUFFLES,
      myVote: room.dareVotes.get(pid) || null,
    };
  }
  if (["lock", "question", "results"].includes(room.phase)) s.lockedDare = dareView(room.lockedDare);
  if (room.phase === "question") {
    s.question = room.question;
    s.targets = room.targets
      .filter((id) => room.players.has(id))
      .map((id) => ({ id, name: room.players.get(id).name }));
    s.myVote = room.votes.get(pid) || null;
  }
  if (room.phase === "results") s.results = room.results;
  return s;
}

function emitState(room) {
  for (const p of room.players.values()) {
    if (p.online && p.socketId) io.to(p.socketId).emit("state", buildState(room, p.id));
  }
}

function emitTick(room) {
  io.to(room.code).emit("tick", { phase: room.phase, timeLeft: room.timeLeft, ...progress(room) });
}

// ---------- phase engine ----------
function clearTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function startTimer(room, seconds, onEnd) {
  clearTimer(room);
  room.timeLeft = seconds;
  room.timerTotal = seconds;
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    emitTick(room);
    if (room.timeLeft <= 0) {
      clearTimer(room);
      onEnd(room);
    }
  }, 1000);
}

function toLobby(room, notice) {
  clearTimer(room);
  room.phase = "lobby";
  room.dareOptions = [];
  room.dareVotes = new Map();
  room.optOuts = new Set();
  room.ready = new Set();
  room.lockedDare = null;
  room.question = null;
  room.targets = [];
  room.votes = new Map();
  room.results = null;
  room.timeLeft = 0;
  room.timerTotal = 0;
  setNotice(room, notice);
  emitState(room);
}

function beginDare(room, { newRound = true, notice = null } = {}) {
  clearTimer(room);
  if (newRound) {
    room.round += 1;
    room.reshuffles = 0;
  }
  room.phase = "dare";
  room.dareVotes = new Map();
  room.optOuts = new Set();
  room.ready = new Set();
  room.lockedDare = null;
  room.question = null;
  room.results = null;
  room.targets = [];
  room.votes = new Map();
  setNotice(room, notice);
  dealDares(room);
  startTimer(room, DARE_SECONDS, resolveDare);
  emitState(room);
}

function resolveDare(room) {
  if (room.phase !== "dare") return;
  clearTimer(room);

  const counts = new Map(room.dareOptions.map((o) => [o.id, 0]));
  let reshuffleVotes = 0;
  for (const v of room.dareVotes.values()) {
    if (v === "reshuffle") reshuffleVotes++;
    else if (counts.has(v)) counts.set(v, counts.get(v) + 1);
  }
  const top = Math.max(...counts.values());

  if (reshuffleVotes > top && room.reshuffles < MAX_RESHUFFLES) {
    room.dareOptions.forEach((o) => returnDare(room, o));
    room.reshuffles += 1;
    room.dareVotes = new Map();
    setNotice(room, "Not feeling those. New dares.");
    dealDares(room);
    startTimer(room, DARE_SECONDS, resolveDare);
    return emitState(room);
  }

  const tied = room.dareOptions.filter((o) => top === 0 || counts.get(o.id) === top);
  const pick = tied[Math.floor(Math.random() * tied.length)];
  room.dareOptions.filter((o) => o !== pick).forEach((o) => returnDare(room, o));
  room.lockedDare = { text: pick.text, cat: pick.cat, by: pick.by };
  room.dareOptions = [];
  room.phase = "lock";
  room.optOuts = new Set();
  setNotice(room, null);
  startTimer(room, LOCK_SECONDS, resolveLock);
  emitState(room);
}

function resolveLock(room) {
  if (room.phase !== "lock") return;
  clearTimer(room);

  const eligible = onlinePlayers(room).filter((p) => !room.optOuts.has(p.id));
  if (eligible.length < 2) {
    returnDare(room, room.lockedDare);
    if (onlinePlayers(room).length < 2) return toLobby(room, "Need at least 2 players to keep going.");
    return beginDare(room, { newRound: false, notice: "Too many people sat out. Pick a different dare." });
  }

  for (const id of room.optOuts) {
    const p = room.players.get(id);
    if (p) p.passes += 1;
  }
  room.phase = "question";
  room.question = pickQuestion(room);
  room.targets = eligible.map((p) => p.id);
  room.votes = new Map();
  setNotice(room, null);
  startTimer(room, QUESTION_SECONDS, finishRound);
  emitState(room);
}

function finishRound(room) {
  if (room.phase !== "question") return;
  clearTimer(room);

  const tally = new Map(room.targets.map((id) => [id, 0]));
  for (const t of room.votes.values()) if (tally.has(t)) tally.set(t, tally.get(t) + 1);
  const max = Math.max(0, ...tally.values());

  const rows = room.targets
    .filter((id) => room.players.has(id))
    .map((id) => ({
      id,
      name: room.players.get(id).name,
      votes: tally.get(id),
      isWinner: max > 0 && tally.get(id) === max,
    }))
    .sort((a, b) => b.votes - a.votes);

  for (const r of rows) if (r.isWinner) room.players.get(r.id).score += 1;

  room.results = { rows, winners: rows.filter((r) => r.isWinner).map((r) => r.name) };
  room.phase = "results";
  room.ready = new Set();
  room.timeLeft = 0;
  room.timerTotal = 0;
  setNotice(room, null);
  emitState(room);
}

// advances the phase if everyone's done; returns true if it did
function checkProgress(room) {
  if (room.phase === "dare" && everyoneVoted(room, room.dareVotes)) {
    resolveDare(room);
    return true;
  }
  if (room.phase === "question" && everyoneVoted(room, room.votes)) {
    finishRound(room);
    return true;
  }
  if (room.phase === "results" && progress(room).done >= readyNeeded(room)) {
    beginDare(room);
    return true;
  }
  return false;
}

function presenceChanged(room) {
  if (ACTIVE.includes(room.phase) && onlinePlayers(room).length < 2) {
    return toLobby(room, "Need at least 2 players to keep going.");
  }
  if (!room.players.get(room.hostId)?.online) migrateHost(room);
  if (!checkProgress(room)) emitState(room);
}

// ---------- sockets ----------
function attach(socket, room, pid) {
  socket.data.code = room.code;
  socket.data.pid = pid;
  socket.join(room.code);
}

const ctx = (socket) => {
  const room = rooms.get(socket.data.code);
  const pid = socket.data.pid;
  if (!room || !pid || !room.players.has(pid)) return {};
  return { room, pid };
};

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}, cb) => {
    let code;
    do code = makeCode();
    while (rooms.has(code));
    const room = newRoom(code);
    rooms.set(code, room);
    const pid = nanoid(12);
    room.creatorId = pid;
    room.hostId = pid;
    addPlayer(room, pid, name || "Host", socket.id);
    attach(socket, room, pid);
    cb?.({ ok: true, pid, code });
    emitState(room);
  });

  socket.on("player:join", ({ code, name } = {}, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found. Double-check the code." });
    if (room.phase === "ended") return cb?.({ ok: false, error: "That game already ended." });
    if (room.players.size >= MAX_PLAYERS) return cb?.({ ok: false, error: "Room is full." });
    const pid = nanoid(12);
    addPlayer(room, pid, name || "Player", socket.id);
    attach(socket, room, pid);
    cb?.({ ok: true, pid, code });
    emitState(room);
  });

  // a phone that dropped (sleep, signal, server restart) walks back in with its saved seat
  socket.on("session:resume", (d = {}, cb) => {
    const code = String(d.code || "").toUpperCase().trim();
    const pid = String(d.pid || "");
    if (!/^[A-Z0-9]{4}$/.test(code) || pid.length < 6 || pid.length > 40) return cb?.({ ok: false });

    let room = rooms.get(code);
    if (!room) {
      room = newRoom(code);
      room.restored = true;
      room.creatorId = pid;
      room.hostId = pid;
      rooms.set(code, room);
      setNotice(room, "Server took a nap. Room's back, scores kept.");
    }
    if (room.restored) applySeen(room, d.seenQ, d.seenD);

    const p = room.players.get(pid);
    if (p) {
      p.online = true;
      p.socketId = socket.id;
      p.lastSeen = Date.now();
    } else {
      if (room.players.size >= MAX_PLAYERS) return cb?.({ ok: false });
      const score = Math.max(0, Math.min(999, Number(d.score) || 0));
      addPlayer(room, pid, d.name, socket.id, score);
    }
    if (pid === room.creatorId) room.hostId = pid;
    // after a restart, whoever was host before gets the role back
    if (room.restored && d.wasHost && !room.hostClaimed) {
      room.hostClaimed = true;
      room.creatorId = pid;
      room.hostId = pid;
    }
    attach(socket, room, pid);
    if (!room.players.get(room.hostId)?.online) migrateHost(room);
    cb?.({ ok: true, restored: room.restored });
    emitState(room);
  });

  socket.on("player:leave", () => {
    const { room, pid } = ctx(socket);
    if (!room) return;
    removePlayer(room, pid);
    socket.leave(room.code);
    socket.data.code = null;
    socket.data.pid = null;
    if (room.players.size === 0) {
      clearTimer(room);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === pid) migrateHost(room);
    presenceChanged(room);
  });

  socket.on("host:start", () => {
    const { room, pid } = ctx(socket);
    if (!room || pid !== room.hostId || room.phase !== "lobby") return;
    if (onlinePlayers(room).length < 2) return;
    beginDare(room);
  });

  socket.on("host:end", () => {
    const { room, pid } = ctx(socket);
    if (!room || pid !== room.hostId || !ACTIVE.includes(room.phase)) return;
    clearTimer(room);
    room.phase = "ended";
    room.timeLeft = 0;
    setNotice(room, null);
    emitState(room);
  });

  socket.on("host:playAgain", () => {
    const { room, pid } = ctx(socket);
    if (!room || pid !== room.hostId || room.phase !== "ended") return;
    for (const p of room.players.values()) {
      p.score = 0;
      p.passes = 0;
    }
    room.round = 0;
    toLobby(room, null);
  });

  socket.on("dare:vote", ({ optionId } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "dare") return;
    const ok =
      room.dareOptions.some((o) => o.id === optionId) ||
      (optionId === "reshuffle" && room.reshuffles < MAX_RESHUFFLES);
    if (!ok) return;
    room.dareVotes.set(pid, optionId);
    if (!checkProgress(room)) emitState(room);
  });

  socket.on("dare:optout", ({ out } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "lock") return;
    if (out) room.optOuts.add(pid);
    else room.optOuts.delete(pid);
    emitState(room);
  });

  socket.on("player:vote", ({ targetId } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "question") return;
    if (!room.targets.includes(targetId) || room.votes.has(pid)) return;
    room.votes.set(pid, targetId);
    emitTick(room);
    checkProgress(room);
  });

  socket.on("player:ready", () => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "results") return;
    if (room.ready.has(pid)) room.ready.delete(pid);
    else room.ready.add(pid);
    if (!checkProgress(room)) emitState(room);
  });

  socket.on("room:addDare", ({ text } = {}, cb) => {
    const { room, pid } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    const t = clean(text, 160);
    if (!t) return cb?.({ ok: false, error: "Write something first." });
    if (room.customDares.length >= MAX_CUSTOM) return cb?.({ ok: false, error: "Dare pile is full." });
    if (room.customDares.some((d) => d.text.toLowerCase() === t.toLowerCase()))
      return cb?.({ ok: false, error: "Someone already added that one." });
    room.customDares.push({ text: t, by: room.players.get(pid).name });
    cb?.({ ok: true });
  });

  socket.on("room:addQuestion", ({ text } = {}, cb) => {
    const { room } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    const q = normalizeQuestion(text);
    if (!q) return cb?.({ ok: false, error: "Write something first." });
    if (room.customQuestions.length >= MAX_CUSTOM) return cb?.({ ok: false, error: "Question pile is full." });
    if (room.customQuestions.some((x) => x.toLowerCase() === q.toLowerCase()))
      return cb?.({ ok: false, error: "Someone already added that one." });
    room.customQuestions.push(q);
    room.questionDeck.unshift(q); // shows up soon
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const pid = socket.data.pid;
    const room = rooms.get(code);
    const p = room?.players.get(pid);
    if (!p || p.socketId !== socket.id) return; // a newer connection already took this seat
    p.online = false;
    p.lastSeen = Date.now();
    presenceChanged(room);
  });
});

// drop seats and rooms that have been empty for a long while
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const p of [...room.players.values()]) {
      if (!p.online && now - p.lastSeen > GRACE_MS) removePlayer(room, p.id);
    }
    if (room.players.size === 0) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

// keep Render's free tier awake while the app is in use
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) setInterval(() => fetch(`${SELF_URL}/health`).catch(() => {}), 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Party game running on port ${PORT}`));
