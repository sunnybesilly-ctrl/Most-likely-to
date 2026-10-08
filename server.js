const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { customAlphabet, nanoid } = require("nanoid");
const { DEFAULT_QUESTIONS, DEFAULT_HINT, DEFAULT_DARES, DARE_LABELS } = require("./data");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 15000, pingTimeout: 45000 });

app.get("/health", (_req, res) => res.type("text").send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

// ---------- timing ----------
const DARE_SECONDS = 60; // shared dare board
const AGREE_SECONDS = 25; // "I'm in / I'm out" on the locked dare
const COUNTDOWN_SECONDS = 5; // big centered "question incoming"
const QUESTION_SECONDS = 30; // time to answer
const CLOSE_MS = 3000; // once everyone's locked in, a short window to change your mind

// ---------- board rules ----------
const MAX_RESHUFFLES = 2;
const BASE_SLOTS = 4; // room favorites + fresh dares always add up to this
const FAV_SLOTS = 2; // top room favorites shown every round
const MAX_WRITTEN = 4; // written dares shown per board
const COOLDOWN_ROUNDS = 3; // a performed dare sits out for a few rounds
const MAX_PLAYERS = 20;
const MAX_CUSTOM = 60;
const GRACE_MS = 20 * 60 * 1000; // how long a dropped phone keeps its seat
const ACTIVE = ["dare", "agree", "countdown", "question", "results"];

// ---------- dare catalog ----------
const DARE_CATS = Object.keys(DEFAULT_DARES);
const DARE_INDEX = new Map(); // id -> { id, text, cat, by }
const DARE_BY_CAT = {};
for (const cat of DARE_CATS) {
  DARE_BY_CAT[cat] = DEFAULT_DARES[cat].map((text, i) => ({ id: `${cat}:${i}`, text, cat, by: null }));
  DARE_BY_CAT[cat].forEach((d) => DARE_INDEX.set(d.id, d));
}

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
  return {
    code,
    creatorId: null,
    hostId: null,
    restored: false,
    hostClaimed: false,
    players: new Map(), // playerId -> { id, name, score, passes, online, socketId, lastSeen }
    order: [],
    phase: "lobby", // lobby | dare | agree | countdown | question | results | ended
    round: 0,

    questionDeck: shuffle(DEFAULT_QUESTIONS),
    customQuestions: [],

    presented: new Set(), // default dare ids already put on a board
    customDares: [], // { id, text, by, n, shown }
    customN: 0,
    boardVotes: new Map(), // dareId -> total votes ever received on boards
    playedRound: new Map(), // dareId -> round it was performed
    favs: new Map(), // playerId -> [dareId, dareId]

    dareOptions: [], // [{ id, text, cat, by, kind: fav|written|fresh }]
    dareVotes: new Map(), // playerId -> dareId | "reshuffle"
    reshuffles: 0,
    lockedDare: null,
    optOuts: new Set(),
    agreeIn: new Set(),

    question: null, // { q, h }
    targets: [],
    votes: new Map(), // playerId -> targetId
    ready: new Set(),
    results: null,

    timer: null,
    endsAt: 0,
    timerTotal: 0,
    timeLeft: 0,
    closing: false,
    closeAt: 0,
    onEnd: null,

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
function everyoneAnswered(room) {
  const on = onlinePlayers(room);
  return on.length > 0 && on.every((p) => room.optOuts.has(p.id) || room.agreeIn.has(p.id));
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
  room.agreeIn.delete(pid);
  room.ready.delete(pid);
  room.favs.delete(pid);
}

function migrateHost(room) {
  const next = room.order.map((id) => room.players.get(id)).find((p) => p && p.online);
  if (next) room.hostId = next.id;
}

function dareById(room, id) {
  if (DARE_INDEX.has(id)) return DARE_INDEX.get(id);
  const c = room.customDares.find((d) => d.id === id);
  return c ? { id: c.id, text: c.text, cat: "custom", by: c.by } : null;
}

function validFavIds(room, ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === "string" && !out.includes(id) && dareById(room, id)) out.push(id);
  }
  return out.slice(0, FAV_SLOTS);
}

// a restarted server skips what this crowd already saw
function applySeen(room, q, d) {
  const sq = new Set((Array.isArray(q) ? q : []).slice(0, 500).map(String));
  const sd = new Set((Array.isArray(d) ? d : []).slice(0, 500).map(String));
  room.questionDeck = room.questionDeck.filter((x) => !sq.has(x.q));
  for (const dare of DARE_INDEX.values()) if (sd.has(dare.text)) room.presented.add(dare.id);
}

// ---------- the dare board ----------
function favCount(room, id) {
  let n = 0;
  for (const f of room.favs.values()) if (f.includes(id)) n++;
  return n;
}
// a pick is worth 3 votes, so the room's stated favorites lead until real votes catch up
const scoreOf = (room, id) => favCount(room, id) * 3 + (room.boardVotes.get(id) || 0);
function onCooldown(room, id) {
  const r = room.playedRound.get(id);
  return r !== undefined && room.round - r < COOLDOWN_ROUNDS;
}

// brand-new written dares jump the line, then the best-scoring ones fill the rest
function pickWritten(room, taken) {
  const pool = room.customDares.filter((d) => !taken.has(d.id) && !onCooldown(room, d.id));
  const newest = pool.filter((d) => !d.shown).sort((a, b) => b.n - a.n).slice(0, 2);
  const rest = pool
    .filter((d) => !newest.includes(d))
    .sort((a, b) => scoreOf(room, b.id) - scoreOf(room, a.id) || b.n - a.n);
  return [...newest, ...rest].slice(0, MAX_WRITTEN);
}

function freshDares(room, taken, n) {
  const out = [];
  const cats = shuffle(DARE_CATS);
  const ok = (d) => !taken.has(d.id) && !onCooldown(room, d.id);
  for (let i = 0; out.length < n && i < n * 8; i++) {
    const cat = cats[i % cats.length];
    let pool = DARE_BY_CAT[cat].filter((d) => ok(d) && !room.presented.has(d.id));
    if (!pool.length) {
      // seen everything in this flavor: start the cycle over
      DARE_BY_CAT[cat].forEach((d) => room.presented.delete(d.id));
      pool = DARE_BY_CAT[cat].filter(ok);
    }
    if (!pool.length) continue;
    const d = pool[Math.floor(Math.random() * pool.length)];
    taken.add(d.id);
    out.push(d);
  }
  return out;
}

function buildBoard(room, exclude = new Set()) {
  const taken = new Set(exclude);
  const opts = [];
  const push = (d, kind) => {
    taken.add(d.id);
    opts.push({ id: d.id, text: d.text, cat: d.cat, by: d.by || null, kind });
  };

  // 1) the room's top favorites
  const favs = shuffle([...DARE_INDEX.values()])
    .filter((d) => !taken.has(d.id) && !onCooldown(room, d.id) && scoreOf(room, d.id) > 0)
    .sort((a, b) => scoreOf(room, b.id) - scoreOf(room, a.id))
    .slice(0, FAV_SLOTS);
  favs.forEach((d) => push(d, "fav"));

  // 2) dares people wrote
  pickWritten(room, taken).forEach((c) => {
    c.shown = true;
    push({ id: c.id, text: c.text, cat: "custom", by: c.by }, "written");
  });

  // 3) fresh ones, so the favorites list keeps growing
  freshDares(room, taken, BASE_SLOTS - favs.length).forEach((d) => push(d, "fresh"));
  return opts;
}

function dealBoard(room, exclude) {
  let opts = buildBoard(room, exclude);
  if (opts.length < 2) opts = buildBoard(room);
  room.dareOptions = opts;
  opts.forEach((o) => {
    if (o.kind !== "written") room.presented.add(o.id);
  });
}

// a dare written mid-vote pops straight onto everyone's board
function addLive(room, d) {
  if (room.phase !== "dare") return false;
  if (room.dareOptions.filter((o) => o.kind === "written").length >= MAX_WRITTEN) return false;
  d.shown = true;
  const opt = { id: d.id, text: d.text, cat: "custom", by: d.by, kind: "written" };
  let at = 0;
  room.dareOptions.forEach((o, i) => {
    if (o.kind === "fav" || o.kind === "written") at = i + 1;
  });
  room.dareOptions.splice(at, 0, opt);
  return true;
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
    case "agree":
      return {
        done: on.filter((p) => room.optOuts.has(p.id) || room.agreeIn.has(p.id)).length,
        total: on.length,
      };
    case "question":
      return { done: on.filter((p) => room.votes.has(p.id)).length, total: on.length };
    case "results":
      return { done: on.filter((p) => room.ready.has(p.id)).length, total: readyNeeded(room) };
    default:
      return { done: 0, total: on.length };
  }
}

function dareLabel(d) {
  return d.cat === "custom" ? DARE_LABELS.custom : DARE_LABELS[d.cat] || "Dare";
}

function rosterFor(room) {
  const on = onlinePlayers(room);
  if (room.phase === "dare") return on.map((p) => ({ id: p.id, name: p.name, done: room.dareVotes.has(p.id) }));
  if (room.phase === "agree")
    return on.map((p) => ({
      id: p.id,
      name: p.name,
      done: room.optOuts.has(p.id) || room.agreeIn.has(p.id),
      status: room.optOuts.has(p.id) ? "out" : room.agreeIn.has(p.id) ? "in" : null,
    }));
  if (room.phase === "question") return on.map((p) => ({ id: p.id, name: p.name, done: room.votes.has(p.id) }));
  return [];
}

function effectiveEnd(room) {
  return room.closing ? Math.min(room.endsAt, room.closeAt) : room.endsAt;
}
const remainingMs = (room) => (room.timer ? Math.max(0, effectiveEnd(room) - Date.now()) : 0);

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
      answer: room.optOuts.has(pid) ? "out" : room.agreeIn.has(pid) ? "in" : null,
      favs: room.favs.get(pid) || [],
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
    timer: {
      left: room.timeLeft,
      total: room.timerTotal,
      remainingMs: remainingMs(room),
      closing: room.closing,
    },
    progress: progress(room),
    roster: rosterFor(room),
    notice:
      room.notice && Date.now() - room.notice.at < 6000
        ? { id: `${room.code}:${room.notice.id}`, text: room.notice.text }
        : null,
  };

  if (room.phase === "dare") {
    const counts = {};
    const voters = {};
    let reshuffleVotes = 0;
    const reshuffleVoters = [];
    for (const [vid, v] of room.dareVotes) {
      const vp = room.players.get(vid);
      if (!vp) continue;
      if (v === "reshuffle") {
        reshuffleVotes++;
        reshuffleVoters.push({ id: vid, name: vp.name });
      } else {
        counts[v] = (counts[v] || 0) + 1;
        (voters[v] = voters[v] || []).push({ id: vid, name: vp.name });
      }
    }
    s.dare = {
      options: room.dareOptions.map((o) => ({
        id: o.id,
        text: o.text,
        by: o.by,
        kind: o.kind,
        label: o.kind === "fav" ? "Room favorite" : dareLabel(o),
        votes: counts[o.id] || 0,
        voters: voters[o.id] || [],
      })),
      reshuffleVotes,
      reshuffleVoters,
      canReshuffle: room.reshuffles < MAX_RESHUFFLES,
      myVote: room.dareVotes.get(pid) || null,
    };
  }
  if (["agree", "countdown", "question", "results"].includes(room.phase) && room.lockedDare) {
    const d = room.lockedDare;
    s.lockedDare = { text: d.text, cat: d.cat, by: d.by, label: dareLabel(d) };
  }
  if (room.phase === "countdown") {
    s.sitting = [...room.optOuts].map((id) => room.players.get(id)?.name).filter(Boolean);
  }
  if (room.phase === "question") {
    s.question = { text: room.question.q, hint: room.question.h };
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
  io.to(room.code).emit("tick", {
    phase: room.phase,
    timeLeft: room.timeLeft,
    remainingMs: remainingMs(room),
    totalMs: room.timerTotal * 1000,
    closing: room.closing,
    ...progress(room),
  });
}

// ---------- timer engine ----------
function clearTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  room.closing = false;
  room.onEnd = null;
}

function startTimer(room, seconds, onEnd) {
  clearTimer(room);
  room.endsAt = Date.now() + seconds * 1000;
  room.timerTotal = seconds;
  room.timeLeft = seconds;
  room.onEnd = onEnd;
  room.timer = setInterval(() => tickRoom(room), 250);
}

function tickRoom(room) {
  if (!room.timer) return;
  const end = effectiveEnd(room);
  if (Date.now() >= end) {
    const fn = room.onEnd;
    clearTimer(room);
    room.timeLeft = 0;
    if (fn) fn(room);
    return;
  }
  const left = Math.ceil((end - Date.now()) / 1000);
  if (left !== room.timeLeft) {
    room.timeLeft = left;
    emitTick(room);
  }
}

// when everyone has answered, shorten the clock to a quick "last chance" window
function syncClosing(room, bump = false) {
  const all =
    room.phase === "dare"
      ? everyoneVoted(room, room.dareVotes)
      : room.phase === "agree"
      ? everyoneAnswered(room)
      : false;
  if (!room.timer) return;
  if (all) {
    if (!room.closing || bump) {
      room.closing = true;
      room.closeAt = Date.now() + CLOSE_MS;
    }
  } else {
    room.closing = false;
  }
}

function refresh(room, bump = false) {
  const before = room.phase;
  const round = room.round;
  syncClosing(room, bump);
  tickRoom(room);
  if (room.phase === before && room.round === round) emitState(room);
}

// ---------- phase engine ----------
function toLobby(room, notice) {
  clearTimer(room);
  room.phase = "lobby";
  room.dareOptions = [];
  room.dareVotes = new Map();
  room.optOuts = new Set();
  room.agreeIn = new Set();
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

function beginDare(room, { newRound = true, notice = null, exclude } = {}) {
  clearTimer(room);
  if (newRound) {
    room.round += 1;
    room.reshuffles = 0;
  }
  room.phase = "dare";
  room.dareVotes = new Map();
  room.optOuts = new Set();
  room.agreeIn = new Set();
  room.ready = new Set();
  room.lockedDare = null;
  room.question = null;
  room.results = null;
  room.targets = [];
  room.votes = new Map();
  setNotice(room, notice);
  dealBoard(room, exclude);
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
  // every vote helps build the room's favorites list
  for (const [id, n] of counts) if (n) room.boardVotes.set(id, (room.boardVotes.get(id) || 0) + n);
  const top = Math.max(0, ...counts.values());

  if (reshuffleVotes > top && room.reshuffles < MAX_RESHUFFLES) {
    room.reshuffles += 1;
    room.dareVotes = new Map();
    setNotice(room, "Not feeling those. New board.");
    dealBoard(room, new Set(room.dareOptions.map((o) => o.id)));
    startTimer(room, DARE_SECONDS, resolveDare);
    return emitState(room);
  }

  const tied = room.dareOptions.filter((o) => top === 0 || counts.get(o.id) === top);
  const pick = tied[Math.floor(Math.random() * tied.length)];
  room.lockedDare = { id: pick.id, text: pick.text, cat: pick.cat, by: pick.by };
  room.dareOptions = [];
  room.phase = "agree";
  room.optOuts = new Set();
  room.agreeIn = new Set();
  setNotice(room, null);
  startTimer(room, AGREE_SECONDS, resolveAgree);
  emitState(room);
}

function resolveAgree(room) {
  if (room.phase !== "agree") return;
  clearTimer(room);

  // no answer counts as "in"
  const eligible = onlinePlayers(room).filter((p) => !room.optOuts.has(p.id));
  if (eligible.length < 2) {
    if (onlinePlayers(room).length < 2) return toLobby(room, "Need at least 2 players to keep going.");
    return beginDare(room, {
      newRound: false,
      notice: "Too many people sat out. Vote a different dare.",
      exclude: new Set([room.lockedDare.id]),
    });
  }

  for (const id of room.optOuts) {
    const p = room.players.get(id);
    if (p) p.passes += 1;
  }
  room.question = pickQuestion(room);
  room.targets = eligible.map((p) => p.id);
  room.votes = new Map();
  room.phase = "countdown";
  setNotice(room, null);
  startTimer(room, COUNTDOWN_SECONDS, startQuestion);
  emitState(room);
}

function startQuestion(room) {
  if (room.phase !== "countdown") return;
  room.phase = "question";
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
  if (rows.some((r) => r.isWinner) && room.lockedDare) room.playedRound.set(room.lockedDare.id, room.round);

  room.results = {
    rows,
    winners: rows.filter((r) => r.isWinner).map((r) => r.name),
    question: room.question.q,
  };
  room.phase = "results";
  room.ready = new Set();
  room.timeLeft = 0;
  room.timerTotal = 0;
  setNotice(room, null);
  emitState(room);
}

// advances the phase if everyone's done; returns true if it did
function checkProgress(room) {
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
  if (checkProgress(room)) return;
  if (room.phase === "dare" || room.phase === "agree") return refresh(room);
  emitState(room);
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
    presenceChanged(room);
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
    if (Array.isArray(d.favs)) room.favs.set(pid, validFavIds(room, d.favs));
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
    presenceChanged(room);
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
    room.timerTotal = 0;
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

  // ----- favorites -----
  socket.on("dares:list", (_p, cb) => {
    const { room } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    const list = [...DARE_INDEX.values()].map((d) => ({
      id: d.id,
      text: d.text,
      cat: d.cat,
      label: DARE_LABELS[d.cat],
      by: null,
    }));
    room.customDares.forEach((d) =>
      list.push({ id: d.id, text: d.text, cat: "custom", label: DARE_LABELS.custom, by: d.by })
    );
    cb?.({ ok: true, list });
  });

  socket.on("fav:set", ({ ids } = {}, cb) => {
    const { room, pid } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    room.favs.set(pid, validFavIds(room, ids));
    cb?.({ ok: true });
    io.to(socket.id).emit("state", buildState(room, pid));
  });

  // ----- the dare board -----
  socket.on("dare:vote", ({ optionId } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "dare") return;
    const ok =
      room.dareOptions.some((o) => o.id === optionId) ||
      (optionId === "reshuffle" && room.reshuffles < MAX_RESHUFFLES);
    if (!ok) return;
    room.dareVotes.set(pid, optionId);
    refresh(room, true);
  });

  socket.on("dare:answer", ({ answer } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "agree") return;
    if (answer === "out") {
      room.optOuts.add(pid);
      room.agreeIn.delete(pid);
    } else if (answer === "in") {
      room.agreeIn.add(pid);
      room.optOuts.delete(pid);
    } else return;
    refresh(room, true);
  });

  // ----- the question -----
  socket.on("player:vote", ({ targetId } = {}) => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "question") return;
    if (!room.targets.includes(targetId) || room.votes.has(pid)) return;
    room.votes.set(pid, targetId);
    if (!checkProgress(room)) emitState(room);
  });

  socket.on("player:ready", () => {
    const { room, pid } = ctx(socket);
    if (!room || room.phase !== "results") return;
    if (room.ready.has(pid)) room.ready.delete(pid);
    else room.ready.add(pid);
    if (!checkProgress(room)) emitState(room);
  });

  // ----- write your own -----
  socket.on("room:addDare", ({ text } = {}, cb) => {
    const { room, pid } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    const t = clean(text, 160);
    if (!t) return cb?.({ ok: false, error: "Write something first." });
    if (room.customDares.length >= MAX_CUSTOM) return cb?.({ ok: false, error: "Dare pile is full." });
    if (room.customDares.some((d) => d.text.toLowerCase() === t.toLowerCase()))
      return cb?.({ ok: false, error: "Someone already added that one." });
    const d = { id: `c:${++room.customN}`, text: t, by: room.players.get(pid).name, n: room.customN, shown: false };
    room.customDares.push(d);
    const live = addLive(room, d);
    cb?.({ ok: true, live });
    if (live) {
      setNotice(room, `${d.by} added a dare`);
      refresh(room, true);
    }
  });

  socket.on("room:addQuestion", ({ text } = {}, cb) => {
    const { room } = ctx(socket);
    if (!room) return cb?.({ ok: false });
    const q = normalizeQuestion(text);
    if (!q) return cb?.({ ok: false, error: "Write something first." });
    if (room.customQuestions.length >= MAX_CUSTOM) return cb?.({ ok: false, error: "Question pile is full." });
    if (room.customQuestions.some((x) => x.q.toLowerCase() === q.toLowerCase()))
      return cb?.({ ok: false, error: "Someone already added that one." });
    const item = { q, h: DEFAULT_HINT };
    room.customQuestions.push(item);
    room.questionDeck.unshift(item); // shows up soon
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
